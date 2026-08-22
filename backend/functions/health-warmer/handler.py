"""SignStream health-warmer Lambda.

Scheduled by EventBridge at a fixed interval (every 5 minutes by default) to
keep the heavy-cold-start Lambdas warm. Reads its target list from the
`WARM_TARGETS` environment variable.

For each target it issues an asynchronous `Invoke` (`InvocationType=Event`)
with a sentinel payload. Each target detects the sentinel, runs its
bootstrap (model load, etc.) to make sure in-memory state is hot, and
returns immediately. AWS Lambda then keeps the container alive for another
5 to 15 minutes, so the next real user request lands on a warm container.

Returns a structured summary so a CloudWatch query can confirm warming is
happening and spot any target whose invokes are failing.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

log = logging.getLogger()
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# The sentinel every warmed target must recognise.
SENTINEL_PAYLOAD: dict[str, Any] = {"warmup": True, "source": "health-warmer"}

_lambda_client = None


def _client():
    global _lambda_client
    if _lambda_client is None:
        _lambda_client = boto3.client("lambda")
    return _lambda_client


def handler(_event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """EventBridge schedule entry point.

    The incoming event is the schedule trigger and is ignored — we always
    do the same thing: warm every target.
    """
    targets = _read_targets()
    if not targets:
        log.warning("WARM_TARGETS is empty; nothing to warm")
        return {"warmed": [], "failed": [], "count": 0}

    payload_bytes = json.dumps(SENTINEL_PAYLOAD).encode("utf-8")
    warmed: list[str] = []
    failed: list[dict[str, str]] = []

    for target in targets:
        try:
            _client().invoke(
                FunctionName=target,
                InvocationType="Event",  # fire-and-forget, returns immediately
                Payload=payload_bytes,
            )
            warmed.append(target)
        except (BotoCoreError, ClientError) as exc:
            log.warning("failed to warm %s: %s", target, exc)
            failed.append({"target": target, "error": str(exc)})

    result = {"warmed": warmed, "failed": failed, "count": len(targets)}
    log.info("warm cycle complete: %s", result)
    return result


def _read_targets() -> list[str]:
    raw = os.environ.get("WARM_TARGETS", "").strip()
    if not raw:
        return []
    return [name.strip() for name in raw.split(",") if name.strip()]
