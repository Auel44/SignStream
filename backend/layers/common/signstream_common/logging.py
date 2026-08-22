"""Structured JSON logging for Lambda handlers.

CloudWatch Logs Insights and every log aggregator understands JSON far
better than free-form strings. This module returns a logger that emits
one JSON object per record so queries like

    fields @timestamp, level, connectionId
    | filter level = "ERROR"

work out of the box.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any, IO

_LEVEL_ENV = "LOG_LEVEL"


class _JsonFormatter(logging.Formatter):
    """Serialise every log record as one JSON line."""

    def format(self, record: logging.LogRecord) -> str:
        dt = datetime.fromtimestamp(record.created, tz=timezone.utc)
        payload: dict[str, Any] = {
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "time": dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z",
        }
        # Extra fields set via logger.info("...", extra={"connectionId": "x"})
        for key, value in record.__dict__.items():
            if key in _RESERVED_KEYS:
                continue
            payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str, separators=(",", ":"))


# LogRecord fields we don't want repeated in the JSON payload.
_RESERVED_KEYS = {
    "args", "asctime", "created", "exc_info", "exc_text", "filename",
    "funcName", "levelname", "levelno", "lineno", "message", "module",
    "msecs", "msg", "name", "pathname", "process", "processName",
    "relativeCreated", "stack_info", "thread", "threadName", "taskName",
}


def get_logger(name: str = "signstream", *, stream: IO[str] | None = None) -> logging.Logger:
    """Return a JSON-formatting logger configured from the LOG_LEVEL env var.

    Safe to call multiple times — configuration is idempotent per logger.

    `stream` is only used the first time a logger with this name is created;
    it exists so tests can inject a StringIO and read back the emitted lines
    (pytest's `capsys` cannot capture a StreamHandler whose stream reference
    was cached before capture started).
    """
    logger = logging.getLogger(name)
    if getattr(logger, "_signstream_configured", False):
        return logger

    level_name = os.environ.get(_LEVEL_ENV, "INFO").upper()
    logger.setLevel(getattr(logging, level_name, logging.INFO))

    # Lambda already attaches a handler; replace it with ours so nothing is
    # doubled up.
    for existing in list(logger.handlers):
        logger.removeHandler(existing)

    handler = logging.StreamHandler(stream if stream is not None else sys.stdout)
    handler.setFormatter(_JsonFormatter())
    logger.addHandler(handler)
    logger.propagate = False

    setattr(logger, "_signstream_configured", True)
    return logger
