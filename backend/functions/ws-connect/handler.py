"""SignStream ws-connect Lambda — API Gateway WebSocket `$connect` route.

Registers a new client session in the DynamoDB `Connections` table so
downstream Lambdas can look up the session's current language and enforce
that the connection actually exists.

The client may pass its initial language as a query string on connect:

    wss://.../?language=BSL

If missing or unrecognised, defaults to ASL. It can be changed later via a
`setLanguage` control message (handled by ws-audio-ingest).

Fails per-connection: a bad DynamoDB write returns 500 and API Gateway
closes only that WebSocket — other connections are unaffected.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError

from signstream_common import (
    VALID_SIGN_LANGUAGES as VALID_LANGUAGES,
    WARMUP_RESPONSE,
    is_warmup,
    now_iso,
)

log = logging.getLogger()
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

DEFAULT_LANGUAGE = "ASL"

# TTL after which an idle Connection record is expired by DynamoDB. Belt and
# braces — the $disconnect Lambda already deletes on normal close, but a
# crashed client that never sends $disconnect won't leave a phantom row
# lingering forever.
CONNECTION_TTL_SECONDS = 3600  # 1 hour

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

    request = event.get("requestContext", {})
    connection_id = request.get("connectionId")
    if not connection_id:
        log.error("$connect event missing connectionId")
        return {"statusCode": 500, "body": "missing connectionId"}

    qs = event.get("queryStringParameters") or {}
    language = qs.get("language", DEFAULT_LANGUAGE)
    if language not in VALID_LANGUAGES:
        log.warning("unknown language %r on connect; using default", language)
        language = DEFAULT_LANGUAGE

    now = datetime.now(timezone.utc)
    timestamp = now_iso()
    expires_at = int(now.timestamp()) + CONNECTION_TTL_SECONDS

    try:
        _connections().put_item(
            Item={
                "connectionId": connection_id,
                "language": language,
                "sequence": 0,
                "connectedAt": timestamp,
                "lastSeenAt": timestamp,
                "expiresAt": expires_at,
            }
        )
    except ClientError as exc:
        log.exception("failed to register %s: %s", connection_id, exc)
        return {"statusCode": 500, "body": "registration failed"}

    log.info("connected %s language=%s", connection_id, language)
    return {"statusCode": 200, "body": "connected"}


