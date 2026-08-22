"""Shared helpers used across every SignStream Lambda.

Each helper is small, dependency-free (except boto3 where needed), and
individually testable. Import only what you need — nothing here has
top-level side effects other than reading module-level constants.
"""

from .logging import get_logger
from .messages import (
    ERROR_TYPE,
    READY_TYPE,
    SIGN_ID_TYPE,
    TRANSCRIPT_DETAIL_TYPE,
    SIGN_ID_DETAIL_TYPE,
    TRANSCRIPT_TYPE,
    LOCKED_SIGN_LANGUAGES,
    SUPPORTED_SIGN_LANGUAGES,
    VALID_SIGN_LANGUAGES,
)
from .time import now_iso
from .warmup import WARMUP_RESPONSE, is_warmup
from .websocket import ConnectionGone, WebSocketPusher

__all__ = [
    "ConnectionGone",
    "ERROR_TYPE",
    "READY_TYPE",
    "SIGN_ID_DETAIL_TYPE",
    "SIGN_ID_TYPE",
    "TRANSCRIPT_DETAIL_TYPE",
    "TRANSCRIPT_TYPE",
    "LOCKED_SIGN_LANGUAGES",
    "SUPPORTED_SIGN_LANGUAGES",
    "VALID_SIGN_LANGUAGES",
    "WARMUP_RESPONSE",
    "WebSocketPusher",
    "get_logger",
    "is_warmup",
    "now_iso",
]

__version__ = "0.1.0"
