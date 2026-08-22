from __future__ import annotations

import base64
import json
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from tests.conftest import make_binary_event, make_control_event


def _h():
    import handler  # noqa: PLC0415
    return handler


# ── Binary audio frame path ───────────────────────────────────────────────────


def test_binary_frame_bumps_sequence_and_enqueues(
    env: None, reset_handler_state: None, patched_boto3: dict[str, MagicMock]
) -> None:
    pcm = b"\x11\x22" * 4000
    result = _h().handler(make_binary_event(pcm_bytes=pcm), None)
    assert result["statusCode"] == 200

    # Atomic sequence bump was issued.
    patched_boto3["table"].update_item.assert_called_once()
    upd = patched_boto3["table"].update_item.call_args.kwargs
    assert "ADD #seq :one" in upd["UpdateExpression"]
    assert upd["ExpressionAttributeNames"]["#seq"] == "sequence"
    assert upd["ConditionExpression"] == "attribute_exists(connectionId)"

    # SQS message body matches the audio-frame schema shape.
    patched_boto3["sqs"].send_message.assert_called_once()
    sent = json.loads(patched_boto3["sqs"].send_message.call_args.kwargs["MessageBody"])
    assert sent["connectionId"] == "conn-1"
    assert sent["sequence"] == 1
    assert sent["language"] == "ASL"
    assert sent["frame"] == base64.b64encode(pcm).decode("ascii")
    assert sent["capturedAt"].endswith("Z")


def test_binary_frame_from_unknown_connection_returns_404(
    env: None, reset_handler_state: None, patched_boto3: dict[str, MagicMock]
) -> None:
    patched_boto3["table"].update_item.side_effect = ClientError(
        {"Error": {"Code": "ConditionalCheckFailedException", "Message": "no such conn"}},
        "UpdateItem",
    )
    result = _h().handler(make_binary_event(), None)
    assert result["statusCode"] == 404
    patched_boto3["sqs"].send_message.assert_not_called()


def test_binary_frame_returns_500_when_sqs_fails(
    env: None, reset_handler_state: None, patched_boto3: dict[str, MagicMock]
) -> None:
    patched_boto3["sqs"].send_message.side_effect = ClientError(
        {"Error": {"Code": "InternalError", "Message": "boom"}},
        "SendMessage",
    )
    result = _h().handler(make_binary_event(), None)
    assert result["statusCode"] == 500


# ── Control message path ─────────────────────────────────────────────────────


def test_set_language_updates_connection(
    env: None, reset_handler_state: None, patched_boto3: dict[str, MagicMock]
) -> None:
    result = _h().handler(make_control_event(), None)
    assert result == {"statusCode": 200}

    upd = patched_boto3["table"].update_item.call_args.kwargs
    assert upd["ExpressionAttributeValues"][":lang"] == "GhSL"
    assert upd["ExpressionAttributeNames"]["#lang"] == "language"


def test_set_language_rejects_invalid_language(
    env: None, reset_handler_state: None, patched_boto3: dict[str, MagicMock]
) -> None:
    result = _h().handler(
        make_control_event(payload={"action": "setLanguage", "language": "Klingon"}),
        None,
    )
    assert result["statusCode"] == 400
    patched_boto3["table"].update_item.assert_not_called()


def test_set_language_for_unknown_connection_returns_404(
    env: None, reset_handler_state: None, patched_boto3: dict[str, MagicMock]
) -> None:
    patched_boto3["table"].update_item.side_effect = ClientError(
        {"Error": {"Code": "ConditionalCheckFailedException", "Message": "no such conn"}},
        "UpdateItem",
    )
    result = _h().handler(make_control_event(), None)
    assert result["statusCode"] == 404


def test_unknown_action_returns_400(
    env: None, reset_handler_state: None, patched_boto3: dict[str, MagicMock]
) -> None:
    result = _h().handler(
        make_control_event(payload={"action": "selfDestruct"}), None
    )
    assert result["statusCode"] == 400


def test_invalid_json_control_returns_400(
    env: None, reset_handler_state: None, patched_boto3: dict[str, MagicMock]
) -> None:
    event = {
        "requestContext": {"connectionId": "conn-1"},
        "body": "{not json",
        "isBase64Encoded": False,
    }
    result = _h().handler(event, None)
    assert result["statusCode"] == 400


# ── Size caps (cost / DoS protection) ────────────────────────────────────────


def test_oversized_audio_frame_rejected_before_any_write(
    env: None, reset_handler_state: None, patched_boto3: dict[str, MagicMock]
) -> None:
    import base64

    handler = _h()
    huge = base64.b64encode(b"\x01" * (200 * 1024)).decode("ascii")  # ~266 KB b64
    event = {
        "requestContext": {"connectionId": "conn-1"},
        "body": huge,
        "isBase64Encoded": True,
    }
    result = handler.handler(event, None)
    assert result["statusCode"] == 413
    # Critically: no DynamoDB write and no SQS send happened.
    patched_boto3["table"].update_item.assert_not_called()
    patched_boto3["sqs"].send_message.assert_not_called()


def test_oversized_control_message_rejected(
    env: None, reset_handler_state: None, patched_boto3: dict[str, MagicMock]
) -> None:
    handler = _h()
    event = {
        "requestContext": {"connectionId": "conn-1"},
        "body": "x" * (8 * 1024),
        "isBase64Encoded": False,
    }
    result = handler.handler(event, None)
    assert result["statusCode"] == 413
    patched_boto3["table"].update_item.assert_not_called()


# ── Envelope handling ────────────────────────────────────────────────────────


def test_missing_body_returns_400(
    env: None, reset_handler_state: None, patched_boto3: dict[str, MagicMock]
) -> None:
    result = _h().handler({"requestContext": {"connectionId": "conn-1"}}, None)
    assert result["statusCode"] == 400


def test_missing_connection_id_returns_500(
    env: None, reset_handler_state: None, patched_boto3: dict[str, MagicMock]
) -> None:
    result = _h().handler({"requestContext": {}}, None)
    assert result["statusCode"] == 500


def test_warmup_sentinel_returns_early(
    env: None, reset_handler_state: None, patched_boto3: dict[str, MagicMock]
) -> None:
    result = _h().handler({"warmup": True}, None)
    assert result == {"warm": True}
    patched_boto3["table"].update_item.assert_not_called()
    patched_boto3["sqs"].send_message.assert_not_called()
