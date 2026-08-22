"""Shared pytest fixtures for the asr Lambda tests."""

from __future__ import annotations

import json
import os
import struct
import sys
from base64 import b64encode
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

# Make the function source importable from the tests folder.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set the minimum required environment for the handler to bootstrap."""
    monkeypatch.setenv("ASR_MODEL", "stub")
    monkeypatch.setenv(
        "WEBSOCKET_ENDPOINT",
        "https://abcd1234.execute-api.eu-west-1.amazonaws.com/test",
    )
    monkeypatch.setenv("EVENT_BUS_NAME", "signstream-test-bus")


@pytest.fixture
def reset_handler_state() -> None:
    """Force the handler module to re-bootstrap (fresh engine/cache/publisher)."""
    import handler  # type: ignore[import-not-found]

    handler._engine = None
    handler._cache = None
    handler._publisher = None


@pytest.fixture
def patched_boto3(monkeypatch: pytest.MonkeyPatch) -> dict[str, MagicMock]:
    """Patch boto3.client so the publisher uses mocks instead of real AWS."""
    events_client = MagicMock(name="events_client")
    ws_client = MagicMock(name="apigatewaymanagementapi_client")

    def fake_client(service_name: str, *_a: Any, **_kw: Any) -> MagicMock:
        if service_name == "events":
            return events_client
        if service_name == "apigatewaymanagementapi":
            return ws_client
        raise AssertionError(f"unexpected boto3 client requested: {service_name}")

    import boto3

    monkeypatch.setattr(boto3, "client", fake_client)
    return {"events": events_client, "ws": ws_client}


def make_sqs_record(
    *,
    connection_id: str = "conn-1",
    sequence: int = 0,
    language: str = "ASL",
    pcm_bytes: bytes | None = None,
    message_id: str = "msg-1",
) -> dict[str, Any]:
    """Build one SQS record matching the audio-frame.json schema."""
    if pcm_bytes is None:
        pcm_bytes = silence_frame()
    body = {
        "connectionId": connection_id,
        "sequence": sequence,
        "language": language,
        "frame": b64encode(pcm_bytes).decode("ascii"),
        "capturedAt": "2026-05-28T14:23:17.412Z",
    }
    return {"messageId": message_id, "body": json.dumps(body)}


def silence_frame(samples: int = 4000) -> bytes:
    """A 250ms 16kHz mono Int16 frame of pure silence."""
    return struct.pack(f"<{samples}h", *([0] * samples))


def speech_frame(samples: int = 4000, amplitude: int = 8000) -> bytes:
    """A 250ms frame of a loud square wave — guaranteed to clear the RMS threshold."""
    pattern = [amplitude if i % 8 < 4 else -amplitude for i in range(samples)]
    return struct.pack(f"<{samples}h", *pattern)
