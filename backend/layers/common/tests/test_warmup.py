from __future__ import annotations

import pytest

from signstream_common.warmup import WARMUP_RESPONSE, is_warmup


@pytest.mark.parametrize(
    "event,expected",
    [
        ({"warmup": True}, True),
        ({"warmup": True, "source": "health-warmer"}, True),
        ({"warmup": False}, False),
        ({"other": "field"}, False),
        ({}, False),
        ("warmup", False),
        (None, False),
        (["warmup", True], False),
    ],
)
def test_is_warmup(event: object, expected: bool) -> None:
    assert is_warmup(event) is expected


def test_warmup_response_shape() -> None:
    assert WARMUP_RESPONSE == {"warm": True}
