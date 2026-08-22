"""SignStream ws-disconnect Lambda — API Gateway WebSocket `$disconnect` route.

Removes the client's row from the DynamoDB Connections table. Idempotent:
if the row is already gone (e.g. TTL evicted it, or a duplicate disconnect
event fires) we swallow the error and return 200 — nothing downstream
should fail because of a stale disconnect.

Loose coupling: does not touch SQS, EventBridge, or any other Lambda.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

from signstream_common import WARMUP_RESPONSE, is_warmup

log = logging.getLogger()
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_table = None


def _connections():
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb").Table(os.environ["CONNECTIONS_TABLE"])
    return _table


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    if is_warmup(event):
        _connections()
        return WARMUP_RESPONSE

    connection_id = event.get("requestContext", {}).get("connectionId")
    if not connection_id:
        log.warning("$disconnect event missing connectionId; nothing to delete")
        return {"statusCode": 200}

    try:
        _connections().delete_item(Key={"connectionId": connection_id})
        log.info("disconnected %s", connection_id)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code == "ResourceNotFoundException":
            log.info("connection %s already removed", connection_id)
        else:
            # Log but still return 200 — API Gateway is closing the socket
            # regardless, and a retry cannot resurrect the connection.
            log.warning("delete failed for %s: %s", connection_id, exc)

    return {"statusCode": 200}
