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

Current data (see pose-generator/src/audit_alphabet.py):
    ASL  — 20 of 26 letters. Missing a, c, l, x, y, z.
    GhSL — 20 of 26, the same set.

GhSL inherited the ASL manual alphabet through Andrew Foster in 1957, so the
letter clips are shared rather than approximated — see
pose-generator/src/copy_alphabet.py. Both languages therefore unlock together
when those six letters land.

Neither can spell yet. The wiring is complete and switches itself on per
letter as clips land, so filling those gaps is a data task, not a code task.

Pace: a spelled letter is flagged to the client and played at 2.2x. That is
what makes the feature usable rather than a nicety — at 1x the mean letter clip
is 1,244 ms, so a five-letter word runs 6.22 s and expires against the avatar's
6 s MAX_SIGN_AGE_MS before it finishes, arriving as a word with letters missing.
At 2.2x it is 2.83 s, and even the 8-letter maximum fits in 4.5 s.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path

log = logging.getLogger(__name__)

#: Longest word worth spelling. Beyond this the avatar spends longer spelling
#: than the speaker spent on the whole sentence, and the viewer has lost the
#: thread — better to skip and let the caption carry it.
MAX_SPELL_LENGTH = 8

#: Shortest. One- and two-letter unknowns are almost always noise from the
#: recogniser rather than real words.
MIN_SPELL_LENGTH = 3

#: Cap per utterance.
#:
#: Was 1, on the reasoning that spelling several words in a row starves the
#: lexical signs behind them. That is a real cost, but it was being paid to
#: avoid a problem the avatar already solves: signs carry the media time they
#: belong to and are dropped once stale, so an over-long spelled run is trimmed
#: by the queue rather than played late.
#:
#: Raised so an utterance is rendered in full — every word either signed or
#: spelled — which is the behaviour asked for. Still bounded: an unbounded run
#: on a sentence of entirely unknown words would queue minutes of letters for
#: one sentence, and MAX_QUEUE would then discard the sentence after it rather
#: than before, which is worse.
MAX_SPELLED_PER_UTTERANCE = 6

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


#: Snapshot of `load_alphabet`'s answer, written by
#: backend/scripts/build-alphabets.py. Cached per process like the dictionaries.
_BUNDLED: dict[str, frozenset[str]] | None = None


def bundled_alphabet(language: str) -> frozenset[str]:
    """Letters `language` can spell, read from the manifest shipped beside it.

    The dev gateway derives this from the clip files directly because it has
    `dictionary/` mounted. The Lambda does not — the clips live on the CDN and
    are fetched by the browser — so it reads the snapshot instead. Same answer,
    different source.

    Returns an empty set if the manifest is absent or does not mention the
    language, which disables spelling for it. That is the safe direction: no
    fingerspelling renders the word as nothing and lets the caption carry it,
    whereas a wrongly-permissive alphabet renders a word with a letter missing,
    which reads as a different word.
    """
    global _BUNDLED
    if _BUNDLED is None:
        try:
            resource = files("dictionaries").joinpath("alphabets.json")
            raw = json.loads(resource.read_text(encoding="utf-8"))
        except (FileNotFoundError, ModuleNotFoundError, OSError):
            # Same fallback as Dictionary.load: the module is not installed as
            # a package under local pytest.
            fallback = Path(__file__).resolve().parent / "dictionaries" / "alphabets.json"
            try:
                raw = json.loads(fallback.read_text(encoding="utf-8"))
            except FileNotFoundError:
                log.warning("no alphabets.json; fingerspelling disabled")
                raw = {}
        # Keyed case-insensitively: callers pass the canonical "GhSL" while the
        # manifest and the allowlist disagree on casing.
        _BUNDLED = {k.upper(): frozenset(v) for k, v in raw.items()}
    return _BUNDLED.get(language.upper(), frozenset())


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
