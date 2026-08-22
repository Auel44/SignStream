"""Shared pytest fixtures for the health-warmer Lambda tests."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture
def reset_handler_state() -> None:
    """Drop the module-level lambda client so each test starts fresh."""
    import handler  # type: ignore[import-not-found]

    handler._lambda_client = None


@pytest.fixture
def patched_lambda_client(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Patch boto3.client('lambda') so no AWS calls happen."""
    lambda_client = MagicMock(name="lambda_client")

    def fake_client(service_name: str, *_a: Any, **_kw: Any) -> MagicMock:
        if service_name == "lambda":
            return lambda_client
        raise AssertionError(f"unexpected boto3 client requested: {service_name}")

    import boto3

    monkeypatch.setattr(boto3, "client", fake_client)
    return lambda_client
