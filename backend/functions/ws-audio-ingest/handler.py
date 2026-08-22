"""SignStream ws-audio-ingest Lambda — API Gateway WebSocket default route.

Two kinds of message arrive on this route:

  * **Binary audio frames.** 250 ms Int16 PCM at 16 kHz mono, sent as a
    raw WebSocket binary frame. API Gateway delivers them base64-encoded
    in `event.body` with `event.isBase64Encoded == True`.
  * **JSON control messages.** e.g. `{"action": "setLanguage",
    "language": "BSL"}`. Delivered as a UTF-8 string in `event.body`
    with `event.isBase64Encoded == False`.

For binary frames we atomically increment a per-connection sequence
counter in DynamoDB, wrap the payload in an audio-frame schema envelope
(see backend/events/audio-frame.json), and drop it on the SQS
`audio-queue`. Zero synchronous work — the `asr` Lambda picks it up.

For control messages we mutate the connection row (e.g. change the
language for the session). No SQS traffic.
"""

from __future__ import annotations

import json
import logging
import os
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

# A legitimate frame is 250 ms of 16 kHz mono Int16 PCM = 8000 bytes, which
# base64-encodes to ~10.7 KB. We allow generous headroom (larger frame sizes,
# occasional 500 ms windows) but reject anything an order of magnitude bigger.
# This caps a malicious client's ability to (a) inflate SQS storage/throughput
# cost and (b) feed oversized buffers into the paid ASR model.
MAX_FRAME_B64_BYTES = 64 * 1024  # 64 KB of base64 ≈ 48 KB raw PCM

# Control messages (JSON) are tiny; reject anything unreasonable to stop a
# client wasting DynamoDB write capacity with junk.
MAX_CONTROL_BODY_BYTES = 4 * 1024

_table = None
_sqs = None


def _connections():
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb").Table(os.environ["CONNECTIONS_TABLE"])
    return _table


def _sqs_client():
    global _sqs
    if _sqs is None:
        _sqs = boto3.client("sqs")
    return _sqs


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    if is_warmup(event):
        _connections()
        _sqs_client()
        return WARMUP_RESPONSE

    connection_id = event.get("requestContext", {}).get("connectionId")
    if not connection_id:
        log.error("event missing connectionId")
        return {"statusCode": 500, "body": "missing connectionId"}

    body = event.get("body")
    if body is None:
        return {"statusCode": 400, "body": "empty body"}

    if event.get("isBase64Encoded"):
        return _handle_audio_frame(connection_id, body)
    return _handle_control_message(connection_id, body)


# ── Control-message path ──────────────────────────────────────────────────────


def _handle_control_message(connection_id: str, body: str) -> dict[str, Any]:
    if len(body) > MAX_CONTROL_BODY_BYTES:
        log.warning("oversized control message from %s (%d bytes)", connection_id, len(body))
        return {"statusCode": 413, "body": "control message too large"}
    try:
        msg = json.loads(body)
    except json.JSONDecodeError:
        log.warning("invalid JSON control message from %s", connection_id)
        return {"statusCode": 400, "body": "invalid json"}

    action = msg.get("action")
    if action == "setLanguage":
        language = msg.get("language")
        if language not in VALID_LANGUAGES:
            return {"statusCode": 400, "body": "invalid language"}
        try:
            _connections().update_item(
                Key={"connectionId": connection_id},
                UpdateExpression="SET #lang = :lang, #ls = :now",
                ConditionExpression="attribute_exists(connectionId)",
                ExpressionAttributeNames={"#lang": "language", "#ls": "lastSeenAt"},
                ExpressionAttributeValues={":lang": language, ":now": now_iso()},
            )
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code == "ConditionalCheckFailedException":
                log.warning("setLanguage for unknown connection %s", connection_id)
                return {"statusCode": 404, "body": "unknown connection"}
            log.exception("setLanguage failed for %s", connection_id)
            return {"statusCode": 500, "body": "update failed"}
        return {"statusCode": 200}

    return {"statusCode": 400, "body": f"unknown action: {action}"}


# ── Audio-frame path ─────────────────────────────────────────────────────────


def _handle_audio_frame(connection_id: str, body_b64: str) -> dict[str, Any]:
    if len(body_b64) > MAX_FRAME_B64_BYTES:
        # Reject before doing any DynamoDB write or SQS send — an oversized
        # frame must not cost us a write or a queue message.
        log.warning(
            "oversized audio frame from %s (%d b64 bytes); dropping",
            connection_id,
            len(body_b64),
        )
        return {"statusCode": 413, "body": "frame too large"}

    timestamp = now_iso()

    try:
        # Atomic per-connection sequence increment + touch lastSeenAt.
        # ADD is DynamoDB's atomic-number operator; ConditionExpression
        # ensures the connection actually exists (i.e. $connect ran first).
        response = _connections().update_item(
            Key={"connectionId": connection_id},
            UpdateExpression="SET #ls = :now ADD #seq :one",
            ConditionExpression="attribute_exists(connectionId)",
            ExpressionAttributeNames={"#ls": "lastSeenAt", "#seq": "sequence"},
            ExpressionAttributeValues={":now": timestamp, ":one": 1},
            ReturnValues="ALL_NEW",
        )
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code == "ConditionalCheckFailedException":
            log.warning("audio frame for unknown connection %s (dropped)", connection_id)
            return {"statusCode": 404, "body": "unknown connection"}
        log.exception("sequence update failed for %s", connection_id)
        return {"statusCode": 500, "body": "sequence update failed"}

    updated = response.get("Attributes", {}) or {}
    sequence = int(updated.get("sequence", 0))
    language = updated.get("language", DEFAULT_LANGUAGE)

    audio_frame = {
        "connectionId": connection_id,
        "sequence": sequence,
        "language": language,
        "frame": body_b64,  # already base64-encoded by API Gateway
        "capturedAt": timestamp,
    }

    try:
        _sqs_client().send_message(
            QueueUrl=os.environ["AUDIO_QUEUE_URL"],
            MessageBody=json.dumps(audio_frame),
        )
    except ClientError:
        log.exception("SQS SendMessage failed for %s", connection_id)
        return {"statusCode": 500, "body": "enqueue failed"}

    return {"statusCode": 200}
