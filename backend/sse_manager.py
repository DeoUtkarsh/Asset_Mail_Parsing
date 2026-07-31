"""
SSE event manager.

Each job_id (= the parent_email UUID) gets its own set of subscriber
queues. Background agents push events here; the SSE endpoint drains them
to the browser.

Events are also buffered per job and replayed to a subscriber that connects
late — otherwise a fast job (e.g. an instant draft) can fire its terminal
event before the browser's EventSource has subscribed, and the UI would hang.
"""
import asyncio
import json
from collections import OrderedDict
from typing import Any

_MAX_EVENTS_PER_JOB = 500
_MAX_BUFFERED_JOBS = 40


class SSEManager:
    def __init__(self) -> None:
        # job_id → list of asyncio.Queue instances (one per browser tab)
        self._subscribers: dict[str, list[asyncio.Queue]] = {}
        # job_id → recent payloads (replayed to late subscribers)
        self._buffer: "OrderedDict[str, list[str]]" = OrderedDict()

    def subscribe(self, job_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        self._subscribers.setdefault(job_id, []).append(queue)
        # Replay buffered events for normal jobs so late subscribers catch up.
        # The persistent "live" bus is different: stale auto_fetch_started notices
        # would re-attach the UI to finished jobs. Live late-join is handled by
        # injecting the *current* active job in the SSE endpoint.
        if job_id != "live":
            for payload in self._buffer.get(job_id, []):
                queue.put_nowait(payload)
        return queue

    def unsubscribe(self, job_id: str, queue: asyncio.Queue) -> None:
        if job_id in self._subscribers:
            try:
                self._subscribers[job_id].remove(queue)
            except ValueError:
                pass
            if not self._subscribers[job_id]:
                del self._subscribers[job_id]
                # Do NOT drop the job buffer here. CloudFront/ALB often drops the
                # SSE socket mid-job; the browser reconnects and needs replay,
                # including phase1_complete. Buffers age out via _MAX_BUFFERED_JOBS.

    def _buffer_event(self, job_id: str, payload: str) -> None:
        buf = self._buffer.get(job_id)
        if buf is None:
            buf = []
            self._buffer[job_id] = buf
            # Bound the number of jobs we retain buffers for
            while len(self._buffer) > _MAX_BUFFERED_JOBS:
                self._buffer.popitem(last=False)
        buf.append(payload)
        if len(buf) > _MAX_EVENTS_PER_JOB:
            del buf[0]

    async def send(self, job_id: str, event_type: str, data: Any) -> None:
        """Push an event to all subscribers of job_id (and buffer it)."""
        payload = json.dumps({"type": event_type, **data} if isinstance(data, dict) else {"type": event_type, "data": data})
        self._buffer_event(job_id, payload)
        for queue in self._subscribers.get(job_id, []):
            await queue.put(payload)

    async def send_all(self, event_type: str, data: Any) -> None:
        """Broadcast an event to ALL active job subscribers."""
        payload = json.dumps({"type": event_type, **data} if isinstance(data, dict) else {"type": event_type, "data": data})
        for queues in self._subscribers.values():
            for queue in queues:
                await queue.put(payload)


# Module-level singleton shared across the FastAPI app and all agents
sse_manager = SSEManager()
