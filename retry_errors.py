"""
Retry extraction for attachments that failed with 504 errors.
Runs independently — no backend/UI needed, just PostgreSQL + internet.

Usage:
    python retry_errors.py
"""
import sys, os, asyncio, json, re, logging

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "backend", ".env"))

import psycopg2
from openai import AsyncOpenAI
from config import settings

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s | %(levelname)-8s | %(name)-20s | %(message)s",
    datefmt="%H:%M:%S",
)
# Quieten noisy httpx/openai debug unless it's important
logging.getLogger("httpx").setLevel(logging.INFO)
logging.getLogger("httpcore").setLevel(logging.INFO)
logger = logging.getLogger(__name__)

client = AsyncOpenAI(
    base_url=settings.NVIDIA_API_BASE_URL,
    api_key=settings.NVIDIA_API_KEY,
)

PROMPT = """\
You are an expert shipbroking data extractor. Extract ALL vessel/ship position data from the text below.

CRITICAL RULES:
1. Find EVERY vessel/ship mentioned — open positions, available tonnage, propose cargo for, etc.
2. Return ONLY a raw JSON array. No markdown, no explanation.
3. Each element = ONE vessel with ALL its specs as key-value pairs.
4. ALWAYS include "region" = primary open port (e.g. "SINGAPORE", "STRAITS", "HALDIA", "IOR").
5. ALWAYS include "vessel_name".
6. All keys lowercase with underscores. Values are strings.
7. If no vessel data at all, return [].

TEXT:
{raw_text}

JSON ARRAY:"""


def _parse_json(text: str) -> list[dict]:
    text = re.sub(r"```(?:json)?\s*", "", text).strip()
    for pattern in [r"\[.*\]", r"\[.*?\]"]:
        m = re.search(pattern, text, re.DOTALL)
        if m:
            try:
                r = json.loads(m.group())
                if isinstance(r, list):
                    return r
            except json.JSONDecodeError:
                pass
    return []


async def retry_attachment(cur, conn, att_id: str, filename: str, raw_text: str):
    logger.info("=" * 55)
    logger.info("Retrying: %s  (raw_text=%d chars)", filename, len(raw_text))
    logger.info("Model: meta/llama-3.1-8b-instruct (fast retry)")

    for attempt in range(1, 4):
        logger.info("  [Attempt %d/3] Sending to LLM…", attempt)
        try:
            resp = await client.chat.completions.create(
                model="meta/llama-3.1-8b-instruct",
                messages=[
                    {"role": "system", "content": "You extract shipbroking vessel data. Output only valid JSON."},
                    {"role": "user", "content": PROMPT.format(raw_text=raw_text[:12000])},
                ],
                temperature=0.05,
                max_tokens=8192,
            )
            content = resp.choices[0].message.content or ""
            logger.info("  LLM responded — %d chars", len(content))
            logger.debug("  First 300 chars of LLM output:\n%s", content[:300])
            vessels = _parse_json(content)
            logger.info("  Parsed → %d vessels found", len(vessels))

            if vessels:
                # Delete any existing vessels for this attachment (safety)
                cur.execute("DELETE FROM vessels WHERE attachment_id = %s", (att_id,))

                for v in vessels:
                    region = v.pop("region", None)
                    normalised = {k.lower().replace(" ", "_"): str(val) for k, val in v.items()}
                    cur.execute(
                        "INSERT INTO vessels (attachment_id, dynamic_data, region) VALUES (%s, %s::jsonb, %s)",
                        (att_id, json.dumps(normalised), region),
                    )

                cur.execute(
                    "UPDATE attachments SET status='done', error_message=NULL WHERE id=%s",
                    (att_id,),
                )
                conn.commit()
                logger.info("  ✓ %s → %d vessels saved, status=done", filename, len(vessels))
                return len(vessels)
            else:
                logger.warning("  No vessels parsed on attempt %d", attempt)

        except Exception as e:
            logger.error("  Attempt %d error: %s", attempt, e)
            if attempt < 3:
                await asyncio.sleep(2 ** attempt)

    logger.error("  ✗ %s — all 3 attempts failed", filename)
    return 0


async def main():
    conn = psycopg2.connect(
        host=settings.PG_HOST, port=settings.PG_PORT,
        dbname=settings.PG_DATABASE, user=settings.PG_USER,
        password=settings.PG_PASSWORD,
    )
    cur = conn.cursor()

    # Fetch all error attachments
    cur.execute(
        "SELECT id, filename, raw_text FROM attachments WHERE status='error' ORDER BY filename"
    )
    errors = cur.fetchall()

    if not errors:
        logger.info("No error attachments found — nothing to retry.")
        cur.close(); conn.close()
        return

    logger.info("Found %d error attachment(s) to retry: %s",
                len(errors), [r[1] for r in errors])

    total_new = 0
    for att_id, filename, raw_text in errors:
        count = await retry_attachment(cur, conn, att_id, filename, raw_text or "")
        total_new += count

    # Final summary
    cur.execute("SELECT COUNT(*) FROM vessels")
    total = cur.fetchone()[0]
    print("\n" + "=" * 50)
    print(f"  Retry complete — {total_new} new vessels added")
    print(f"  Total vessels in DB: {total}")
    print("=" * 50)

    cur.close(); conn.close()


if __name__ == "__main__":
    asyncio.run(main())
