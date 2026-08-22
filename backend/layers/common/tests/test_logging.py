from __future__ import annotations

import io
import json
import logging

import pytest

from signstream_common.logging import get_logger


def _flush(logger: logging.Logger) -> None:
    for handler in logger.handlers:
        handler.flush()


def test_log_output_is_valid_json() -> None:
    stream = io.StringIO()
    logger = get_logger("test.json", stream=stream)
    logger.info("hello")
    _flush(logger)

    line = stream.getvalue().strip().splitlines()[-1]
    payload = json.loads(line)
    assert payload["level"] == "INFO"
    assert payload["message"] == "hello"
    assert payload["logger"] == "test.json"


def test_extra_fields_are_included() -> None:
    stream = io.StringIO()
    logger = get_logger("test.extra", stream=stream)
    logger.info("payload", extra={"connectionId": "c1", "sequence": 3})
    _flush(logger)

    line = stream.getvalue().strip().splitlines()[-1]
    payload = json.loads(line)
    assert payload["connectionId"] == "c1"
    assert payload["sequence"] == 3


def test_exception_is_serialised() -> None:
    stream = io.StringIO()
    logger = get_logger("test.exception", stream=stream)
    try:
        raise ValueError("boom")
    except ValueError:
        logger.exception("failed")
    _flush(logger)

    line = stream.getvalue().strip().splitlines()[-1]
    payload = json.loads(line)
    assert payload["level"] == "ERROR"
    assert "ValueError: boom" in payload["exception"]


def test_get_logger_is_idempotent() -> None:
    a = get_logger("test.idempotent")
    b = get_logger("test.idempotent")
    assert a is b
    # No stacked handlers.
    assert len(a.handlers) == 1


def test_respects_log_level_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOG_LEVEL", "WARNING")
    logger = get_logger("test.level")
    assert logger.level == logging.WARNING
