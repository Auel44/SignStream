"""Tests for the health-warmer Lambda handler."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError


def _import_handler():
    import handler  # noqa: PLC0415

    return handler


def test_warms_each_configured_target(
    monkeypatch: pytest.MonkeyPatch,
    reset_handler_state: None,
    patched_lambda_client: MagicMock,
) -> None:
    monkeypatch.setenv("WARM_TARGETS", "signstream-asr,signstream-text-to-gloss")

    handler = _import_handler()
    result = handler.handler({}, None)

    assert result["count"] == 2
    assert set(result["warmed"]) == {"signstream-asr", "signstream-text-to-gloss"}
    assert result["failed"] == []

    assert patched_lambda_client.invoke.call_count == 2
    for call in patched_lambda_client.invoke.call_args_list:
        kwargs = call.kwargs
        assert kwargs["InvocationType"] == "Event"
        payload = json.loads(kwargs["Payload"].decode("utf-8"))
        assert payload["warmup"] is True
        assert payload["source"] == "health-warmer"


def test_empty_target_list_is_no_op(
    monkeypatch: pytest.MonkeyPatch,
    reset_handler_state: None,
    patched_lambda_client: MagicMock,
) -> None:
    monkeypatch.delenv("WARM_TARGETS", raising=False)

    handler = _import_handler()
    result = handler.handler({}, None)

    assert result == {"warmed": [], "failed": [], "count": 0}
    patched_lambda_client.invoke.assert_not_called()


def test_whitespace_in_target_list_is_tolerated(
    monkeypatch: pytest.MonkeyPatch,
    reset_handler_state: None,
    patched_lambda_client: MagicMock,
) -> None:
    monkeypatch.setenv("WARM_TARGETS", "  a , , b  ,  ")

    handler = _import_handler()
    result = handler.handler({}, None)

    assert result["count"] == 2
    assert set(result["warmed"]) == {"a", "b"}


def test_partial_failure_continues_to_next_target(
    monkeypatch: pytest.MonkeyPatch,
    reset_handler_state: None,
    patched_lambda_client: MagicMock,
) -> None:
    monkeypatch.setenv("WARM_TARGETS", "broken-target,good-target")
    patched_lambda_client.invoke.side_effect = [
        ClientError(
            {"Error": {"Code": "ResourceNotFoundException", "Message": "no such function"}},
            "Invoke",
        ),
        {"StatusCode": 202},
    ]

    handler = _import_handler()
    result = handler.handler({}, None)

    assert result["warmed"] == ["good-target"]
    assert len(result["failed"]) == 1
    assert result["failed"][0]["target"] == "broken-target"
    assert "ResourceNotFoundException" in result["failed"][0]["error"]


def test_eventbridge_payload_is_ignored(
    monkeypatch: pytest.MonkeyPatch,
    reset_handler_state: None,
    patched_lambda_client: MagicMock,
) -> None:
    """The schedule trigger sends a CloudWatch-style event; the warmer ignores it."""
    monkeypatch.setenv("WARM_TARGETS", "signstream-asr")
    schedule_event = {
        "version": "0",
        "id": "abc",
        "detail-type": "Scheduled Event",
        "source": "aws.events",
    }

    handler = _import_handler()
    result = handler.handler(schedule_event, None)

    assert result["count"] == 1
    assert result["warmed"] == ["signstream-asr"]
