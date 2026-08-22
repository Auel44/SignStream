"""Tests for the per-connection LRU cache."""

from __future__ import annotations

import time

import pytest

from session_state import SessionCache


def test_get_returns_none_for_unknown_connection() -> None:
    cache = SessionCache(max_size=4, ttl_seconds=60)
    assert cache.get("nope") is None


def test_put_and_get_roundtrip() -> None:
    cache = SessionCache(max_size=4, ttl_seconds=60)
    cache.put("c1", {"x": 1})
    assert cache.get("c1") == {"x": 1}


def test_put_overwrites_previous_state() -> None:
    cache = SessionCache(max_size=4, ttl_seconds=60)
    cache.put("c1", {"v": 1})
    cache.put("c1", {"v": 2})
    assert cache.get("c1") == {"v": 2}
    assert cache.size() == 1


def test_drop_removes_entry() -> None:
    cache = SessionCache(max_size=4, ttl_seconds=60)
    cache.put("c1", "state")
    cache.drop("c1")
    assert cache.get("c1") is None


def test_lru_evicts_least_recently_used() -> None:
    cache = SessionCache(max_size=3, ttl_seconds=60)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.put("c", 3)
    # touch 'a' so 'b' becomes the LRU
    assert cache.get("a") == 1
    cache.put("d", 4)
    assert cache.get("b") is None
    assert cache.get("a") == 1
    assert cache.get("c") == 3
    assert cache.get("d") == 4


def test_ttl_expiry(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_now = [1000.0]

    def fake_monotonic() -> float:
        return fake_now[0]

    monkeypatch.setattr(time, "monotonic", fake_monotonic)
    cache = SessionCache(max_size=4, ttl_seconds=10)
    cache.put("c1", "state")

    fake_now[0] += 5
    assert cache.get("c1") == "state"  # within TTL

    fake_now[0] += 20
    assert cache.get("c1") is None  # expired


def test_prune_expired(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_now = [1000.0]

    def fake_monotonic() -> float:
        return fake_now[0]

    monkeypatch.setattr(time, "monotonic", fake_monotonic)
    cache = SessionCache(max_size=4, ttl_seconds=10)
    cache.put("a", 1)
    cache.put("b", 2)
    fake_now[0] += 100
    assert cache.prune_expired() == 2
    assert cache.size() == 0


def test_invalid_constructor_args() -> None:
    with pytest.raises(ValueError):
        SessionCache(max_size=0, ttl_seconds=10)
    with pytest.raises(ValueError):
        SessionCache(max_size=4, ttl_seconds=0)
