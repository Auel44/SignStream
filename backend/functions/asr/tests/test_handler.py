"""End-to-end tests for the asr Lambda handler.

These tests use the StubEngine and mocked AWS clients (no network calls).
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

from tests.conftest import make_sqs_record, silence_frame, speech_frame


def _import_handler():
    import handler  # noqa: PLC0415 — late import after env fixtures
    return handler


def test_handler_processes_speech_then_silence_and_pushes_to_client(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    handler = _import_handler()
    records = []

    # Three speech frames.
    for i in range(3):
        records.append(make_sqs_record(sequence=i, pcm_bytes=speech_frame(), message_id=f"m{i}"))
    # Two silence frames to trigger a final.
    for i in range(3, 5):
        records.append(make_sqs_record(sequence=i, pcm_bytes=silence_frame(), message_id=f"m{i}"))

    result = handler.handler({"Records": records}, None)

    assert result == {"batchItemFailures": []}

    ws = patched_boto3["ws"]
    events = patched_boto3["events"]

    # WebSocket received at least the partials and the final.
    ws_payloads = [
        json.loads(call.kwargs["Data"].decode("utf-8"))
        for call in ws.post_to_connection.call_args_list
    ]
    assert any(p.get("type") == "transcript" and not p["isFinal"] for p in ws_payloads)
    assert any(p.get("type") == "transcript" and p["isFinal"] for p in ws_payloads)

    # EventBridge only received the final.
    assert events.put_events.called
    entries = events.put_events.call_args.kwargs["Entries"]
    assert len(entries) == 1
    detail = json.loads(entries[0]["Detail"])
    assert detail["isFinal"] is True
    assert detail["language"] == "ASL"
    assert detail["asrModel"] == "stub"
    assert entries[0]["DetailType"] == "signstream.transcript"


def test_handler_drops_record_with_invalid_language(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    """A frame carrying a path-traversal / unknown language is a poison
    record: dropped (not retried), and nothing is published downstream."""
    handler = _import_handler()
    record = make_sqs_record(
        pcm_bytes=speech_frame(),
        language="../../../../etc/passwd",
        message_id="m-badlang",
    )
    result = handler.handler({"Records": [record]}, None)
    assert result == {"batchItemFailures": []}
    patched_boto3["events"].put_events.assert_not_called()


def test_handler_drops_poison_record_silently(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    handler = _import_handler()

    bad_record = {"messageId": "bad-1", "body": "{not-json"}
    result = handler.handler({"Records": [bad_record]}, None)
    # Poison records are NOT returned in batchItemFailures — they go through
    # successfully so they are removed from the queue (the DLQ catches things
    # that retry-fail, not things that are structurally broken).
    assert result == {"batchItemFailures": []}


def test_handler_marks_unexpected_failure_for_retry(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = _import_handler()
    handler._bootstrap()  # ensure cache exists

    def boom(*_a, **_k):
        raise RuntimeError("simulated transient failure")

    # Replace the engine with one that explodes on stream_frame.
    handler._engine.stream_frame = boom  # type: ignore[assignment]

    record = make_sqs_record(pcm_bytes=speech_frame(), message_id="m-boom")
    result = handler.handler({"Records": [record]}, None)
    assert result == {"batchItemFailures": [{"itemIdentifier": "m-boom"}]}


def test_handler_missing_required_field_is_poison(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    handler = _import_handler()
    body = {"connectionId": "c1", "sequence": 0, "language": "ASL"}  # no 'frame'
    record = {"messageId": "miss-1", "body": json.dumps(body)}
    result = handler.handler({"Records": [record]}, None)
    assert result == {"batchItemFailures": []}


def test_handler_warmup_ping_returns_early_and_loads_engine(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    """The health-warmer fires {warmup: true} — we should bootstrap and return fast."""
    handler = _import_handler()
    result = handler.handler({"warmup": True, "source": "health-warmer"}, None)
    assert result == {"warm": True, "engine": "stub"}
    # No SQS records were processed, so neither client should have been called.
    patched_boto3["ws"].post_to_connection.assert_not_called()
    patched_boto3["events"].put_events.assert_not_called()


def test_handler_gone_connection_does_not_fail_record(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    """If the client disconnects, we should not retry — just drop the push."""
    from botocore.exceptions import ClientError

    handler = _import_handler()
    handler._bootstrap()

    patched_boto3["ws"].post_to_connection.side_effect = ClientError(
        {"Error": {"Code": "GoneException", "Message": "gone"}},
        "PostToConnection",
    )

    record = make_sqs_record(pcm_bytes=speech_frame(), message_id="m-gone")
    result = handler.handler({"Records": [record]}, None)
    assert result == {"batchItemFailures": []}
