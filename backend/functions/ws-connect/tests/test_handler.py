from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from tests.conftest import make_connect_event


def _h():
    import handler  # noqa: PLC0415
    return handler


def test_connect_writes_row_with_defaults(
    env: None, reset_handler_state: None, patched_boto3: MagicMock
) -> None:
    result = _h().handler(make_connect_event(), None)
    assert result == {"statusCode": 200, "body": "connected"}

    patched_boto3.put_item.assert_called_once()
    item = patched_boto3.put_item.call_args.kwargs["Item"]
    assert item["connectionId"] == "conn-1"
    assert item["language"] == "ASL"
    assert item["sequence"] == 0
    assert "connectedAt" in item and "lastSeenAt" in item and "expiresAt" in item


def test_connect_honours_query_string_language(
    env: None, reset_handler_state: None, patched_boto3: MagicMock
) -> None:
    _h().handler(make_connect_event(language="GhSL"), None)
    item = patched_boto3.put_item.call_args.kwargs["Item"]
    assert item["language"] == "GhSL"


def test_connect_falls_back_to_default_on_unknown_language(
    env: None, reset_handler_state: None, patched_boto3: MagicMock
) -> None:
    _h().handler(make_connect_event(language="Klingon"), None)
    item = patched_boto3.put_item.call_args.kwargs["Item"]
    assert item["language"] == "ASL"


def test_connect_returns_500_when_dynamodb_fails(
    env: None, reset_handler_state: None, patched_boto3: MagicMock
) -> None:
    patched_boto3.put_item.side_effect = ClientError(
        {"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "slow down"}},
        "PutItem",
    )
    result = _h().handler(make_connect_event(), None)
    assert result["statusCode"] == 500


def test_connect_missing_connection_id_returns_500(
    env: None, reset_handler_state: None, patched_boto3: MagicMock
) -> None:
    result = _h().handler({"requestContext": {}}, None)
    assert result["statusCode"] == 500
    patched_boto3.put_item.assert_not_called()


def test_warmup_sentinel_returns_early(
    env: None, reset_handler_state: None, patched_boto3: MagicMock
) -> None:
    result = _h().handler({"warmup": True}, None)
    assert result == {"warm": True}
    patched_boto3.put_item.assert_not_called()


def test_connect_accepts_mixed_case_ghsl(
    env: None, reset_handler_state: None, patched_boto3: MagicMock
) -> None:
    """GhSL is the one allowlist entry that is not all-caps.

    The allowlist is a case-sensitive exact match, and the extension now sends
    the language on the $connect query string, so this pins the exact spelling
    the client must use. Lowercasing anywhere in that chain would silently
    downgrade GhSL users to the ASL default.
    """
    _h().handler(make_connect_event(language="GhSL"), None)
    assert patched_boto3.put_item.call_args.kwargs["Item"]["language"] == "GhSL"


def test_connect_rejects_lowercased_ghsl(
    env: None, reset_handler_state: None, patched_boto3: MagicMock
) -> None:
    """Guard the above: 'ghsl' must NOT be accepted, so the client is forced to
    send the canonical spelling rather than relying on server-side coercion."""
    _h().handler(make_connect_event(language="ghsl"), None)
    assert patched_boto3.put_item.call_args.kwargs["Item"]["language"] == "ASL"


def test_connect_rejects_locked_bsl(
    env: None, reset_handler_state: None, patched_boto3: MagicMock
) -> None:
    """BSL is locked until a keypoint dataset exists, so it must fall back to
    the default rather than registering a session that cannot be signed."""
    _h().handler(make_connect_event(language="BSL"), None)
    assert patched_boto3.put_item.call_args.kwargs["Item"]["language"] == "ASL"
