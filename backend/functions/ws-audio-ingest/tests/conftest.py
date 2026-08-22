from __future__ import annotations

import base64
import json
import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONNECTIONS_TABLE", "signstream-test-connections")
    monkeypatch.setenv(
        "AUDIO_QUEUE_URL",
        "https://sqs.eu-west-1.amazonaws.com/000000000000/signstream-audio",
    )


@pytest.fixture
def reset_handler_state() -> None:
    import handler  # type: ignore[import-not-found]

    handler._table = None
    handler._sqs = None


@pytest.fixture
def patched_boto3(monkeypatch: pytest.MonkeyPatch) -> dict[str, MagicMock]:
    table = MagicMock(name="connections_table")
    # Default: UpdateItem returns a plausible ALL_NEW attribute set.
    table.update_item.return_value = {
        "Attributes": {"connectionId": "conn-1", "language": "ASL", "sequence": 1}
    }
    resource = MagicMock(name="dynamodb_resource")
    resource.Table.return_value = table

    sqs = MagicMock(name="sqs_client")

    def fake_resource(service_name: str, *_a: Any, **_kw: Any) -> MagicMock:
        if service_name == "dynamodb":
            return resource
        raise AssertionError(f"unexpected boto3 resource: {service_name}")

    def fake_client(service_name: str, *_a: Any, **_kw: Any) -> MagicMock:
        if service_name == "sqs":
            return sqs
        raise AssertionError(f"unexpected boto3 client: {service_name}")

    import boto3

    monkeypatch.setattr(boto3, "resource", fake_resource)
    monkeypatch.setattr(boto3, "client", fake_client)
    return {"table": table, "sqs": sqs}


def make_binary_event(
    *, connection_id: str = "conn-1", pcm_bytes: bytes | None = None
) -> dict[str, Any]:
    if pcm_bytes is None:
        pcm_bytes = b"\x00\x00" * 4000  # 250 ms silence
    return {
        "requestContext": {"connectionId": connection_id, "routeKey": "$default"},
        "body": base64.b64encode(pcm_bytes).decode("ascii"),
        "isBase64Encoded": True,
    }


def make_control_event(
    *, connection_id: str = "conn-1", payload: dict[str, Any] | None = None
) -> dict[str, Any]:
    if payload is None:
        payload = {"action": "setLanguage", "language": "GhSL"}
    return {
        "requestContext": {"connectionId": connection_id, "routeKey": "$default"},
        "body": json.dumps(payload),
        "isBase64Encoded": False,
    }
