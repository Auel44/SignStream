"""Publish sign IDs on the two output paths.

  1. **API Gateway management API** — pushes each sign ID directly to the
     originating WebSocket client so the avatar can play it immediately.
  2. **EventBridge `signstream.signId`** — internal fan-out for analytics
     and observability (see backend/events/sign-id.json).
"""

from __future__ import annotations

import json
import logging
from typing import Any

import boto3
from botocore.exceptions import ClientError

from signstream_common import now_iso

log = logging.getLogger(__name__)

_DETAIL_TYPE = "signstream.signId"


class Publisher:
    def __init__(
        self,
        *,
        websocket_endpoint: str,
        event_bus_name: str = "signstream-bus",
        event_source: str = "signstream.text-to-gloss",
    ) -> None:
        if not websocket_endpoint:
            raise ValueError("websocket_endpoint is required")
        self._event_bus_name = event_bus_name
        self._event_source = event_source
        self._events = boto3.client("events")
        self._ws = boto3.client(
            "apigatewaymanagementapi",
            endpoint_url=websocket_endpoint,
        )

    def push_sign_id_to_client(
        self, *, connection_id: str, sign_id: str, fingerspell: bool = False
    ) -> bool:
        """Send one sign id to the browser.

        `fingerspell` marks this as one letter of a spelled word rather than a
        lexical sign, and the avatar plays it at FINGERSPELL_SPEED (2.2x) with a
        much shorter cross-fade. That is not decoration: a five-letter word at
        lexical pace is five ~1.5 s clips, so the avatar falls ~11 s behind the
        speaker on a single word and the letters expire against MAX_SIGN_AGE_MS
        before the word finishes.

        Omitted, the client defaults it to false. This field was missing here
        while the dev gateway sent it, so spelling ran at lexical pace in
        production and at the right pace locally — the divergence that hides
        longest.
        """
        payload: dict[str, object] = {"type": "signId", "id": sign_id}
        if fingerspell:
            payload["fingerspell"] = True
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

    def publish_sign_id_event(
        self,
        *,
        connection_id: str,
        language: str,
        sign_id: str,
        gloss: str | None = None,
        source_text: str | None = None,
        transcript_published_at: str | None = None,
    ) -> None:
        detail: dict[str, Any] = {
            "connectionId": connection_id,
            "language": language,
            "signId": sign_id,
            "publishedAt": now_iso(),
        }
        if gloss is not None:
            detail["gloss"] = gloss
        if source_text is not None:
            detail["sourceText"] = source_text
        if transcript_published_at is not None:
            detail["transcriptPublishedAt"] = transcript_published_at

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


