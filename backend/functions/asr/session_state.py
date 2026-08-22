"""In-memory LRU cache holding streaming ASR engine state per WebSocket session.

Streaming ASR carries a small state object across consecutive frames of the
same session. Keeping that state in the warm Lambda container — rather than
serialising it to DynamoDB every frame — keeps per-frame latency under 5 ms.

A cache miss is recoverable: the engine starts fresh on the next frame and
catches up within an utterance. So the policy is best-effort:

  - LRU eviction once `max_size` connections are tracked
  - Idle TTL so abandoned sessions don't keep their state forever
  - Thread-safe (Lambda invocations may overlap on a single warm container)
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any


@dataclass
class _Entry:
    state: Any
    last_seen: float


class SessionCache:
    """LRU cache with TTL keyed by API Gateway connection id."""

    def __init__(self, *, max_size: int = 128, ttl_seconds: int = 600) -> None:
        if max_size < 1:
            raise ValueError("max_size must be >= 1")
        if ttl_seconds < 1:
            raise ValueError("ttl_seconds must be >= 1")
        self._max_size = max_size
        self._ttl = ttl_seconds
        self._lock = threading.Lock()
        self._entries: "OrderedDict[str, _Entry]" = OrderedDict()

    def get(self, connection_id: str) -> Any | None:
        """Return the cached state for a connection, or None if missing or expired."""
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(connection_id)
            if entry is None:
                return None
            if now - entry.last_seen > self._ttl:
                # expired — drop it
                del self._entries[connection_id]
                return None
            # mark recently used
            self._entries.move_to_end(connection_id)
            entry.last_seen = now
            return entry.state

    def put(self, connection_id: str, state: Any) -> None:
        now = time.monotonic()
        with self._lock:
            if connection_id in self._entries:
                entry = self._entries[connection_id]
                entry.state = state
                entry.last_seen = now
                self._entries.move_to_end(connection_id)
            else:
                self._entries[connection_id] = _Entry(state=state, last_seen=now)
            self._evict_if_needed_locked()

    def drop(self, connection_id: str) -> None:
        with self._lock:
            self._entries.pop(connection_id, None)

    def prune_expired(self) -> int:
        """Walk the cache and drop expired entries. Returns the number dropped."""
        now = time.monotonic()
        removed = 0
        with self._lock:
            for cid in list(self._entries.keys()):
                if now - self._entries[cid].last_seen > self._ttl:
                    del self._entries[cid]
                    removed += 1
        return removed

    def size(self) -> int:
        with self._lock:
            return len(self._entries)

    # ── internal ─────────────────────────────────────────────────────────────────

    def _evict_if_needed_locked(self) -> None:
        while len(self._entries) > self._max_size:
            self._entries.popitem(last=False)
