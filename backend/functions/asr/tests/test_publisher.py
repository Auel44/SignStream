"""Tests for the Publisher (EventBridge + API Gateway management push)."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from publisher import Publisher


def test_push_transcript_to_client_sends_websocket_json(
    patched_boto3: dict[str, MagicMock],
) -> None:
    pub = Publisher(websocket_endpoint="https://example.execute-api.eu-west-1.amazonaws.com/p")
    ok = pub.push_transcript_to_client(connection_id="c1", text="hello", is_final=False)
    assert ok is True

    ws = patched_boto3["ws"]
    ws.post_to_connection.assert_called_once()
    sent = json.loads(ws.post_to_connection.call_args.kwargs["Data"].decode("utf-8"))
    assert sent == {"type": "transcript", "text": "hello", "isFinal": False}


def test_push_transcript_returns_false_on_gone_connection(
    patched_boto3: dict[str, MagicMock],
) -> None:
    pub = Publisher(websocket_endpoint="https://example.execute-api.eu-west-1.amazonaws.com/p")
    patched_boto3["ws"].post_to_connection.side_effect = ClientError(
        {"Error": {"Code": "GoneException", "Message": "gone"}},
        "PostToConnection",
    )
    ok = pub.push_transcript_to_client(connection_id="c1", text="hi", is_final=True)
    assert ok is False


def test_publish_transcript_event_emits_eventbridge(
    patched_boto3: dict[str, MagicMock],
) -> None:
    pub = Publisher(
        websocket_endpoint="https://example.execute-api.eu-west-1.amazonaws.com/p",
        event_bus_name="my-bus",
        event_source="my.asr",
    )
    pub.publish_transcript_event(
        connection_id="c1",
        language="ASL",
        text="hello world",
        is_final=True,
        last_frame_sequence=12,
        asr_model="stub",
    )

    events = patched_boto3["events"]
    events.put_events.assert_called_once()
    entries = events.put_events.call_args.kwargs["Entries"]
    assert len(entries) == 1
    entry = entries[0]
    assert entry["Source"] == "my.asr"
    assert entry["DetailType"] == "signstream.transcript"
    assert entry["EventBusName"] == "my-bus"

    detail = json.loads(entry["Detail"])
    assert detail["connectionId"] == "c1"
    assert detail["language"] == "ASL"
    assert detail["text"] == "hello world"
    assert detail["isFinal"] is True
    assert detail["lastFrameSequence"] == 12
    assert detail["asrModel"] == "stub"
    assert detail["publishedAt"].endswith("Z")


def test_constructor_rejects_empty_endpoint() -> None:
    with pytest.raises(ValueError):
        Publisher(websocket_endpoint="")
