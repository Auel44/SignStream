"""Millisecond-precision ISO-8601 UTC timestamps.

Everything that hits the wire (SQS messages, EventBridge details,
WebSocket payloads) uses the same format so timestamps sort and diff
across services without surprises.
"""

from __future__ import annotations

from datetime import datetime, timezone


def now_iso() -> str:
    """Return the current UTC time as `YYYY-MM-DDTHH:MM:SS.mmmZ`."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
