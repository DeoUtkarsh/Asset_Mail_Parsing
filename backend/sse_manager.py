"""
SSE event manager.

Each job_id (= the parent_email UUID) gets its own set of subscriber
queues. Background agents push events here; the SSE endpoint drains them
to the browser.
"""
import asyncio
import json
from typing import Any


class SSEManager:
    def __init__(self) -> None:
        # job_id → list of asyncio.Queue instances (one per browser tab)
        self._subscribers: dict[str, list[asyncio.Queue]] = {}

    def subscribe(self, job_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        self._subscribers.setdefault(job_id, []).append(queue)
        return queue

    def unsubscribe(self, job_id: str, queue: asyncio.Queue) -> None:
        if job_id in self._subscribers:
            try:
                self._subscribers[job_id].remove(queue)
            except ValueError:
                pass
            if not self._subscribers[job_id]:
                del self._subscribers[job_id]

    async def send(self, job_id: str, event_type: str, data: Any) -> None:
        """Push an event to all subscribers of job_id."""
        payload = json.dumps({"type": event_type, **data} if isinstance(data, dict) else {"type": event_type, "data": data})
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
