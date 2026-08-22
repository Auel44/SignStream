from __future__ import annotations

from unittest.mock import MagicMock

from botocore.exceptions import ClientError

from tests.conftest import make_disconnect_event


def _h():
    import handler  # noqa: PLC0415
    return handler


def test_disconnect_deletes_connection_row(
    env: None, reset_handler_state: None, patched_boto3: MagicMock
) -> None:
    result = _h().handler(make_disconnect_event("conn-1"), None)
    assert result == {"statusCode": 200}
    patched_boto3.delete_item.assert_called_once_with(Key={"connectionId": "conn-1"})


def test_disconnect_is_idempotent_when_row_already_gone(
    env: None, reset_handler_state: None, patched_boto3: MagicMock
) -> None:
    patched_boto3.delete_item.side_effect = ClientError(
        {"Error": {"Code": "ResourceNotFoundException", "Message": "not found"}},
        "DeleteItem",
    )
    result = _h().handler(make_disconnect_event(), None)
    assert result == {"statusCode": 200}


def test_disconnect_tolerates_transient_dynamodb_error(
    env: None, reset_handler_state: None, patched_boto3: MagicMock
) -> None:
    """Even a real error still returns 200 — the socket is closing anyway."""
    patched_boto3.delete_item.side_effect = ClientError(
        {"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "slow"}},
        "DeleteItem",
    )
    result = _h().handler(make_disconnect_event(), None)
    assert result == {"statusCode": 200}


def test_disconnect_missing_connection_id_returns_200(
    env: None, reset_handler_state: None, patched_boto3: MagicMock
) -> None:
    result = _h().handler({"requestContext": {}}, None)
    assert result == {"statusCode": 200}
    patched_boto3.delete_item.assert_not_called()


def test_warmup_sentinel_returns_early(
    env: None, reset_handler_state: None, patched_boto3: MagicMock
) -> None:
    result = _h().handler({"warmup": True}, None)
    assert result == {"warm": True}
    patched_boto3.delete_item.assert_not_called()
