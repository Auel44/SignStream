"""Shared pytest fixtures for the text-to-gloss Lambda tests."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "WEBSOCKET_ENDPOINT",
        "https://abcd1234.execute-api.eu-west-1.amazonaws.com/test",
    )
    monkeypatch.setenv("EVENT_BUS_NAME", "signstream-test-bus")


@pytest.fixture
def reset_handler_state() -> None:
    import handler  # type: ignore[import-not-found]

    handler._publisher = None
    handler._dictionaries.clear()


@pytest.fixture
def patched_boto3(monkeypatch: pytest.MonkeyPatch) -> dict[str, MagicMock]:
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


def make_transcript_event(
    *,
    connection_id: str = "conn-1",
    language: str = "ASL",
    text: str = "hello",
    is_final: bool = True,
    published_at: str = "2026-05-28T14:23:18.612Z",
) -> dict[str, Any]:
    """Build an EventBridge event matching backend/events/transcript.json."""
    return {
        "version": "0",
        "source": "signstream.asr",
        "detail-type": "signstream.transcript",
        "detail": {
            "connectionId": connection_id,
            "language": language,
            "text": text,
            "isFinal": is_final,
            "publishedAt": published_at,
        },
    }
