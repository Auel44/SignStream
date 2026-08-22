from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from signstream_common.websocket import ConnectionGone, WebSocketPusher


@pytest.fixture
def patched_boto3(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    client = MagicMock(name="apigatewaymanagementapi_client")

    def fake_client(service_name: str, *_a: Any, **_kw: Any) -> MagicMock:
        assert service_name == "apigatewaymanagementapi"
        return client

    import boto3

    monkeypatch.setattr(boto3, "client", fake_client)
    return client


def test_push_serialises_payload_to_json_utf8(patched_boto3: MagicMock) -> None:
    pusher = WebSocketPusher(endpoint_url="https://x.example.com/prod")
    ok = pusher.push(connection_id="c1", payload={"type": "transcript", "text": "hi"})
    assert ok is True

    call = patched_boto3.post_to_connection.call_args.kwargs
    assert call["ConnectionId"] == "c1"
    assert json.loads(call["Data"].decode("utf-8")) == {"type": "transcript", "text": "hi"}


def test_push_returns_false_on_gone_by_default(patched_boto3: MagicMock) -> None:
    patched_boto3.post_to_connection.side_effect = ClientError(
        {"Error": {"Code": "GoneException", "Message": "gone"}},
        "PostToConnection",
    )
    pusher = WebSocketPusher(endpoint_url="https://x.example.com/prod")
    assert pusher.push(connection_id="c1", payload={"type": "signId", "id": "asl-hello-v1"}) is False


def test_push_raises_on_gone_when_asked(patched_boto3: MagicMock) -> None:
    patched_boto3.post_to_connection.side_effect = ClientError(
        {"Error": {"Code": "GoneException", "Message": "gone"}},
        "PostToConnection",
    )
    pusher = WebSocketPusher(endpoint_url="https://x.example.com/prod")
    with pytest.raises(ConnectionGone):
        pusher.push(
            connection_id="c1",
            payload={"type": "signId", "id": "asl-hello-v1"},
            raise_on_gone=True,
        )


def test_push_reraises_unexpected_error(patched_boto3: MagicMock) -> None:
    patched_boto3.post_to_connection.side_effect = ClientError(
        {"Error": {"Code": "InternalError", "Message": "boom"}},
        "PostToConnection",
    )
    pusher = WebSocketPusher(endpoint_url="https://x.example.com/prod")
    with pytest.raises(ClientError):
        pusher.push(connection_id="c1", payload={"type": "error", "message": "x"})


def test_constructor_rejects_empty_endpoint() -> None:
    with pytest.raises(ValueError):
        WebSocketPusher(endpoint_url="")
