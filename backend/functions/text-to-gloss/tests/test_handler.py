"""End-to-end tests for the text-to-gloss Lambda handler."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from tests.conftest import make_transcript_event


def _import_handler():
    import handler  # noqa: PLC0415

    return handler


def test_handler_maps_transcript_to_sign_ids_and_pushes(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    handler = _import_handler()
    event = make_transcript_event(text="Hello, how are you today?", language="ASL")

    result = handler.handler(event, None)

    assert result["emitted"] >= 2  # at least hello + today; likely 3 with how-you
    assert result["connectionId"] == "conn-1"
    assert result["language"] == "ASL"

    ws = patched_boto3["ws"]
    events = patched_boto3["events"]

    ws_payloads = [
        json.loads(call.kwargs["Data"].decode("utf-8"))
        for call in ws.post_to_connection.call_args_list
    ]
    assert all(p["type"] == "signId" for p in ws_payloads)
    ids = [p["id"] for p in ws_payloads]
    assert "asl-hello-v1" in ids
    assert "asl-today-v1" in ids

    # One EventBridge fan-out per sign ID.
    assert events.put_events.call_count == len(ws_payloads)


def test_handler_ignores_partial_transcripts(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    handler = _import_handler()
    event = make_transcript_event(text="hello", is_final=False)

    result = handler.handler(event, None)

    assert result == {"emitted": 0, "reason": "partial"}
    patched_boto3["ws"].post_to_connection.assert_not_called()
    patched_boto3["events"].put_events.assert_not_called()


def test_handler_ignores_empty_text(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    handler = _import_handler()
    event = make_transcript_event(text="   ")

    result = handler.handler(event, None)
    assert result == {"emitted": 0, "reason": "empty-text"}


def test_handler_rejects_path_traversal_language(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    """A crafted language must be dropped at the boundary and never reach the
    dictionary loader."""
    handler = _import_handler()
    event = make_transcript_event(text="hello", language="../../../../etc/passwd")

    result = handler.handler(event, None)
    assert result == {"emitted": 0, "reason": "invalid-language"}
    patched_boto3["ws"].post_to_connection.assert_not_called()
    patched_boto3["events"].put_events.assert_not_called()


def test_handler_missing_required_field_returns_early(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    handler = _import_handler()
    event = {
        "detail-type": "signstream.transcript",
        "detail": {"connectionId": "c1", "language": "ASL"},  # no text/isFinal
    }
    result = handler.handler(event, None)
    assert result["emitted"] == 0
    assert result["reason"].startswith("missing:")


def test_handler_empty_detail_dropped(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    handler = _import_handler()
    event = {"detail-type": "signstream.transcript"}
    result = handler.handler(event, None)
    assert result == {"emitted": 0, "reason": "no-detail"}


def test_handler_warmup_ping_returns_early(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    handler = _import_handler()
    result = handler.handler({"warmup": True, "source": "health-warmer"}, None)
    assert result == {"warm": True}
    patched_boto3["ws"].post_to_connection.assert_not_called()
    patched_boto3["events"].put_events.assert_not_called()


def test_handler_survives_gone_connection(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    handler = _import_handler()
    patched_boto3["ws"].post_to_connection.side_effect = ClientError(
        {"Error": {"Code": "GoneException", "Message": "gone"}},
        "PostToConnection",
    )
    event = make_transcript_event(text="hello")
    # Should not raise — the publisher swallows GoneException.
    result = handler.handler(event, None)
    assert result["emitted"] >= 1


def test_handler_loads_language_specific_dictionary(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    handler = _import_handler()

    # One input, two different outcomes — only possible if the per-language
    # dictionary is really being consulted. ASL has a HELLO clip; the GhSL
    # lexicon genuinely has no HELLO recording, so it must emit nothing rather
    # than falling back to another language's table.
    handler.handler(make_transcript_event(text="hello", language="ASL"), None)
    ghsl = handler.handler(make_transcript_event(text="hello", language="GhSL"), None)

    ids = [
        json.loads(call.kwargs["Data"].decode("utf-8"))["id"]
        for call in patched_boto3["ws"].post_to_connection.call_args_list
    ]
    assert "asl-hello-v1" in ids
    assert ghsl["emitted"] == 0
    assert not any(i.startswith("ghsl-") for i in ids)


def test_handler_drops_locked_bsl(
    env: None,
    reset_handler_state: None,
    patched_boto3: dict[str, MagicMock],
) -> None:
    """BSL is locked out at this boundary too, not only at $connect.

    Every stage re-validates the language independently — the value travels
    through DynamoDB, SQS and EventBridge, so no stage may assume an earlier
    one checked it.
    """
    handler = _import_handler()
    result = handler.handler(make_transcript_event(text="hello", language="BSL"), None)
    assert result == {"emitted": 0, "reason": "invalid-language"}
    patched_boto3["ws"].post_to_connection.assert_not_called()
