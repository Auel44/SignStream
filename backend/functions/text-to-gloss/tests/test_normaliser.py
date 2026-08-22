"""Tests for the text normaliser."""

from __future__ import annotations

import pytest

from normaliser import normalise, tokenise


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Hello, World!", "hello world"),
        ("I don't know.", "i do not know"),
        ("Can't stop won't stop", "can not stop will not stop"),
        ("She's happy", "she is happy"),
        ("They're gonna go", "they are going to go"),
        ("Let's eat", "let us eat"),
        ("What's your name?", "what is your name"),
        ("It's 5 o'clock", "it is 5 o clock"),
        ("café", "cafe"),
        ("   multiple    spaces   ", "multiple spaces"),
        ("", ""),
    ],
)
def test_normalise_common_forms(raw: str, expected: str) -> None:
    assert normalise(raw) == expected


def test_normalise_preserves_hyphens() -> None:
    assert normalise("thank-you") == "thank-you"


def test_normalise_preserves_digits() -> None:
    assert normalise("Room 101!") == "room 101"


def test_tokenise_splits_on_spaces() -> None:
    assert tokenise("Hello, world!") == ["hello", "world"]


def test_tokenise_empty_input_returns_empty_list() -> None:
    assert tokenise("") == []
    assert tokenise("   ") == []
    assert tokenise("!!!") == []


def test_tokenise_expands_contractions() -> None:
    assert tokenise("I don't want to") == ["i", "do", "not", "want", "to"]
