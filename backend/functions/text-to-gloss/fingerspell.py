"""Fingerspelling: spell a word letter by letter when it has no sign.

What this is
------------
Every sign language has a manual alphabet, and signers use it exactly where a
lexical sign is unavailable — names, places, brands, technical terms. It is not
a fallback invented here; it is what a human interpreter does with "AirPods".

Without it those words simply vanish. A product keynote maps almost nothing:
*AirPods, spatial, acoustic, computational* are not in a 1,232-word everyday
lexicon and never will be, so the avatar stands still through the sentences
that carry the most information.

Correctness before coverage
---------------------------
A wrong handshape is a wrong letter. Spelling "AIRPODS" with a guessed 'A'
does not communicate the word — it communicates a different word, confidently,
which is worse than showing nothing at all.

So this module refuses to spell anything it cannot spell *completely*. The
alphabet is read from the clips that actually exist on disk (see
`load_alphabet`); a language missing even one required letter simply does not
fingerspell that word. There is no interpolation, no substitution, no
"close enough" handshape.

Current data (see `scripts/audit_alphabet.py`):
    ASL  — 20 of 26 letters. Missing a, c, l, x, y, z.
    GhSL —  0 of 26.

Neither can spell yet. The wiring is complete and switches itself on per
letter as clips land, so filling those gaps is a data task, not a code task.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

log = logging.getLogger(__name__)

#: Longest word worth spelling. Beyond this the avatar spends longer spelling
#: than the speaker spent on the whole sentence, and the viewer has lost the
#: thread — better to skip and let the caption carry it.
MAX_SPELL_LENGTH = 8

#: Shortest. One- and two-letter unknowns are almost always noise from the
#: recogniser rather than real words.
MIN_SPELL_LENGTH = 3

#: Cap per utterance. Spelling several words in a row starves every lexical
#: sign behind them, which costs more meaning than the spelled words add.
MAX_SPELLED_PER_UTTERANCE = 1

_ALPHABETIC = re.compile(r"^[a-z]+$")


@dataclass(frozen=True)
class Fingerspelling:
    """A word rendered as a sequence of letter sign ids."""

    word: str
    sign_ids: tuple[str, ...]


def load_alphabet(language: str, available_sign_ids: set[str]) -> frozenset[str]:
    """Which letters this language can actually sign.

    Derived from the clips present, never assumed. `available_sign_ids` is the
    set of ids known to resolve — normally the clip filenames — so a letter is
    only usable once its keypoints exist.
    """
    prefix = language.lower()
    return frozenset(
        chr(code)
        for code in range(ord("a"), ord("z") + 1)
        if f"{prefix}-{chr(code)}-v1" in available_sign_ids
    )


def can_spell(word: str, alphabet: frozenset[str]) -> bool:
    """True only if EVERY letter is available. Partial spelling is not spelling."""
    return bool(word) and all(ch in alphabet for ch in word)


def should_spell(word: str) -> bool:
    """Whether an unmapped word is worth spelling at all."""
    if not _ALPHABETIC.match(word):
        return False  # numbers and punctuation need their own treatment
    return MIN_SPELL_LENGTH <= len(word) <= MAX_SPELL_LENGTH


def spell(word: str, language: str, alphabet: frozenset[str]) -> Fingerspelling | None:
    """Render `word` as letter sign ids, or None if it cannot be spelled fully."""
    word = word.lower()
    if not should_spell(word) or not can_spell(word, alphabet):
        return None
    prefix = language.lower()
    return Fingerspelling(
        word=word,
        sign_ids=tuple(f"{prefix}-{ch}-v1" for ch in word),
    )
