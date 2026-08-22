"""Thin wrapper over the API Gateway management API for pushing to clients.

Both `asr` (transcripts) and `text-to-gloss` (sign IDs) push messages
back to WebSocket clients through the same code path. Centralising it
here means:

  * Every Lambda handles `GoneException` identically (client closed the
    tab — do not retry, do not fail the invocation).
  * boto3 client creation is done once per warm container.
  * Payload serialisation is uniform.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import boto3
from botocore.exceptions import ClientError

log = logging.getLogger(__name__)


class ConnectionGone(Exception):
    """Raised by callers who want to know the client has disconnected."""


class WebSocketPusher:
    """Wraps `apigatewaymanagementapi.post_to_connection`."""

    def __init__(self, endpoint_url: str) -> None:
        if not endpoint_url:
            raise ValueError("endpoint_url is required (WEBSOCKET_ENDPOINT env var)")
        self._client = boto3.client(
            "apigatewaymanagementapi",
            endpoint_url=endpoint_url,
        )

    def push(
        self,
        *,
        connection_id: str,
        payload: dict[str, Any],
        raise_on_gone: bool = False,
    ) -> bool:
        """Send `payload` as a JSON frame to the given connection.

        Returns True on success. Returns False (or raises `ConnectionGone`
        when `raise_on_gone=True`) if the client is already disconnected.
        All other errors are logged and re-raised so the caller can
        surface them to SQS as retryable.
        """
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        try:
            self._client.post_to_connection(
                ConnectionId=connection_id,
                Data=data,
            )
            return True
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code in {"GoneException", "410"}:
                log.info("connection %s is gone; dropping push", connection_id)
                if raise_on_gone:
                    raise ConnectionGone(connection_id) from exc
                return False
            log.warning(
                "post_to_connection failed for %s: %s",
                connection_id,
                exc,
                exc_info=True,
            )
            raise
