"""Warm-up sentinel handling.

The health-warmer Lambda pings every target with a `{"warmup": true}`
payload every few minutes. Each target has to detect the sentinel at the
top of its handler and return immediately. Centralising the check here
means all six Lambdas do it identically.
"""

from __future__ import annotations

from typing import Any


WARMUP_RESPONSE: dict[str, bool] = {"warm": True}


def is_warmup(event: Any) -> bool:
    """Return True when the event is a health-warmer sentinel ping."""
    return isinstance(event, dict) and event.get("warmup") is True
