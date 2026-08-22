"""Emits transcript results on the two output paths the handler cares about.

  1. **EventBridge** — for downstream consumers (text-to-gloss, analytics).
  2. **API Gateway management API** — pushed directly back to the
     originating WebSocket client so the user sees live captions without
     waiting for the gloss stage.

A failure in one path does not block the other: each call is wrapped in its
own try/except and logged. The handler decides whether to fail the SQS
record overall (it doesn't — we'd rather lose one frame's transcript than
re-process the same audio).
"""

from __future__ import annotations

import json
import logging
from typing import Any

import boto3
from botocore.exceptions import ClientError

from signstream_common import now_iso

log = logging.getLogger(__name__)

# All transcripts share these EventBridge envelope fields.
_DETAIL_TYPE = "signstream.transcript"


class Publisher:
    """Wraps boto3 clients for EventBridge + API Gateway management."""

    def __init__(
        self,
        *,
        websocket_endpoint: str,
        event_bus_name: str = "signstream-bus",
        event_source: str = "signstream.asr",
    ) -> None:
        if not websocket_endpoint:
            raise ValueError("websocket_endpoint is required")
        self._event_bus_name = event_bus_name
        self._event_source = event_source
        self._events = boto3.client("events")
        # endpoint_url is required for the management API and is per-stage,
        # e.g. https://abcd1234.execute-api.eu-west-1.amazonaws.com/prod
        self._ws = boto3.client(
            "apigatewaymanagementapi",
            endpoint_url=websocket_endpoint,
        )

    # ── Direct push to the client over the existing WebSocket ─────────────────

    def push_transcript_to_client(
        self,
        *,
        connection_id: str,
        text: str,
        is_final: bool,
    ) -> bool:
        """Send a transcript JSON frame to the WebSocket client. Returns False if the
        connection is gone (client closed the tab, etc.)."""
        payload = {"type": "transcript", "text": text, "isFinal": is_final}
        try:
            self._ws.post_to_connection(
                ConnectionId=connection_id,
                Data=json.dumps(payload).encode("utf-8"),
            )
            return True
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code in {"GoneException", "410"}:
                log.info("connection %s is gone; will not retry", connection_id)
                return False
            log.warning(
                "post_to_connection failed for %s: %s",
                connection_id,
                exc,
                exc_info=True,
            )
            return False

    # ── Fan-out for downstream stages ─────────────────────────────────────────

    def publish_transcript_event(
        self,
        *,
        connection_id: str,
        language: str,
        text: str,
        is_final: bool,
        first_frame_sequence: int | None = None,
        last_frame_sequence: int | None = None,
        asr_model: str | None = None,
    ) -> None:
        """Emit one transcript onto the EventBridge bus.

        Schema: see backend/events/transcript.json. Only finalised transcripts
        are typically published — partials are too noisy for downstream
        consumers — but the caller decides.
        """
        detail: dict[str, Any] = {
            "connectionId": connection_id,
            "language": language,
            "text": text,
            "isFinal": is_final,
            "publishedAt": now_iso(),
        }
        if first_frame_sequence is not None:
            detail["firstFrameSequence"] = first_frame_sequence
        if last_frame_sequence is not None:
            detail["lastFrameSequence"] = last_frame_sequence
        if asr_model is not None:
            detail["asrModel"] = asr_model

        try:
            self._events.put_events(
                Entries=[
                    {
                        "Source": self._event_source,
                        "DetailType": _DETAIL_TYPE,
                        "Detail": json.dumps(detail),
                        "EventBusName": self._event_bus_name,
                    }
                ]
            )
        except ClientError as exc:
            log.warning("put_events failed: %s", exc, exc_info=True)

    def push_error_to_client(self, *, connection_id: str, message: str) -> None:
        """Surface a non-fatal error to the client so it can show a status."""
        payload = {"type": "error", "message": message}
        try:
            self._ws.post_to_connection(
                ConnectionId=connection_id,
                Data=json.dumps(payload).encode("utf-8"),
            )
        except ClientError:
            pass


