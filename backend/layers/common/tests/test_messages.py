from __future__ import annotations

from signstream_common import (
    ERROR_TYPE,
    READY_TYPE,
    SIGN_ID_DETAIL_TYPE,
    SIGN_ID_TYPE,
    TRANSCRIPT_DETAIL_TYPE,
    TRANSCRIPT_TYPE,
    LOCKED_SIGN_LANGUAGES,
    VALID_SIGN_LANGUAGES,
)


def test_websocket_type_strings() -> None:
    assert READY_TYPE == "ready"
    assert TRANSCRIPT_TYPE == "transcript"
    assert SIGN_ID_TYPE == "signId"
    assert ERROR_TYPE == "error"


def test_eventbridge_detail_types() -> None:
    assert TRANSCRIPT_DETAIL_TYPE == "signstream.transcript"
    assert SIGN_ID_DETAIL_TYPE == "signstream.signId"


def test_valid_sign_languages_excludes_locked_languages() -> None:
    """BSL is recognised but not served — no keypoint dataset exists for it.

    Pinned so re-enabling it is a deliberate act: shipping the language without
    clips would show a Deaf user an avatar that never moves.
    """
    assert VALID_SIGN_LANGUAGES == {"ASL", "GhSL"}
    assert LOCKED_SIGN_LANGUAGES == {"BSL"}
    assert not (VALID_SIGN_LANGUAGES & LOCKED_SIGN_LANGUAGES)
