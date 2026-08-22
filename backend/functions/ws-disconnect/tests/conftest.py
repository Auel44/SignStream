from __future__ import annotations

import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONNECTIONS_TABLE", "signstream-test-connections")


@pytest.fixture
def reset_handler_state() -> None:
    import handler  # type: ignore[import-not-found]

    handler._table = None


@pytest.fixture
def patched_boto3(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    table = MagicMock(name="connections_table")
    resource = MagicMock(name="dynamodb_resource")
    resource.Table.return_value = table

    def fake_resource(service_name: str, *_a: Any, **_kw: Any) -> MagicMock:
        if service_name == "dynamodb":
            return resource
        raise AssertionError(f"unexpected boto3 resource: {service_name}")

    import boto3

    monkeypatch.setattr(boto3, "resource", fake_resource)
    return table


def make_disconnect_event(connection_id: str = "conn-1") -> dict[str, Any]:
    return {"requestContext": {"connectionId": connection_id, "eventType": "DISCONNECT"}}
