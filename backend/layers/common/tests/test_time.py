from __future__ import annotations

import re

from signstream_common.time import now_iso


_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def test_now_iso_matches_millisecond_utc_format() -> None:
    ts = now_iso()
    assert _ISO_RE.match(ts), f"unexpected format: {ts!r}"


def test_two_successive_calls_are_monotonic_or_equal() -> None:
    a = now_iso()
    b = now_iso()
    assert a <= b
