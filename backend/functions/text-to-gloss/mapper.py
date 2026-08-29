"""Map normalised English tokens to gloss labels, then to dictionary sign IDs.

Sign languages are not word-for-word English. Some English phrases collapse
into one sign ("thank you" -> THANK-YOU), some English words vanish
entirely ("to be" is often unmarked), and some idioms have no direct sign
at all. This module uses **greedy longest-match n-gram lookup** against a
per-language dictionary: try the longest phrase first, fall back to
shorter ones, skip anything unmapped.

Unknown words are logged and dropped. The client still displays the
captioned transcript, so a missed sign is a graceful degradation, not a
failure.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path
from typing import Iterable

from fingerspell import MAX_SPELLED_PER_UTTERANCE, spell

log = logging.getLogger(__name__)

# The only sign languages we ship a usable dictionary for. Any language value
# that reaches Dictionary.load MUST be one of these — this is the allowlist
# that prevents the language string (which originates from untrusted client
# input and travels through DynamoDB → SQS → EventBridge) from being used to
# build an arbitrary filesystem path (directory-traversal). Case-insensitive.
#
# BSL is locked out: no public BSL keypoint dataset exists to convert, so the
# dictionary holds a single placeholder clip. Accepting the language would
# promise a translation that cannot be performed. See
# signstream_common.messages for the steps to re-enable it.
VALID_LANGUAGES = frozenset({"ASL", "GHSL"})

# Version suffix on every emitted sign ID. Bumped only when a specific
# sign's pose clip changes in a backwards-incompatible way.
DICTIONARY_VERSION = "v1"

# Longest phrase (in tokens) we will try before falling back. Larger values
# cost O(n*max) per transcript token; 3 covers most idioms.
_MAX_PHRASE_LEN = 3

# Function words that are dropped before mapping.
#
# This is a throughput decision, not a linguistic shortcut. Every emitted sign
# occupies the avatar for a second or more, and the avatar is already slower
# than speech — so each of these costs a slot that a content word could have
# used. Sign languages also do not mark most of them: they have no articles,
# and copulas are typically unexpressed, so omitting them is closer to natural
# signing than including them would be.
#
# Deliberately conservative. Only words that are near-contentless on their own
# appear here — negation, quantifiers and pronouns are NOT skipped, because
# dropping those changes meaning.
_SKIPPED_TOKENS = frozenset(
    {
        "a", "an", "the",          # articles — absent from signed languages
        "is", "are", "was", "were", "be", "been", "being", "am",  # copulas
        "of", "to",                # bare prepositions when not part of a phrase
        "uh", "um", "er", "ah",    # disfluencies
    }
)


@dataclass(frozen=True)
class MappedSign:
    """One sign emitted by the mapper."""

    gloss: str
    sign_id: str
    source_tokens: tuple[str, ...]
    #: True when this sign is one letter of a fingerspelled word rather than a
    #: lexical sign. The client plays these faster and closer together, which
    #: is how fingerspelling actually looks.
    is_fingerspell: bool = False


class Dictionary:
    """A per-language English-phrase to gloss table."""

    def __init__(self, language: str, phrase_to_gloss: dict[str, str]) -> None:
        if not language:
            raise ValueError("language is required")
        self.language = language
        # Normalise dictionary keys to lowercase — the normaliser already
        # emits lowercase, but a hand-authored dictionary might not.
        self._entries = {k.lower(): v for k, v in phrase_to_gloss.items()}

    def lookup(self, phrase: str) -> str | None:
        return self._entries.get(phrase)

    def size(self) -> int:
        return len(self._entries)

    @classmethod
    def load(cls, language: str) -> "Dictionary":
        """Load a bundled dictionary JSON file by language code.

        Security: `language` is validated against the fixed allowlist before
        it is ever interpolated into a filename. Without this, a crafted
        value such as "../../etc/passwd" would let an attacker read arbitrary
        JSON files off the container filesystem (directory traversal). The
        allowlist makes the filename a closed set of three known-safe names.
        """
        if not isinstance(language, str):
            raise ValueError(f"language must be a string, got {type(language).__name__}")
        code = language.upper()
        if code not in VALID_LANGUAGES:
            raise ValueError(f"unsupported sign language: {language!r}")

        filename = f"{code.lower()}.json"
        try:
            resource = files("dictionaries").joinpath(filename)
            data = json.loads(resource.read_text(encoding="utf-8"))
        except (FileNotFoundError, ModuleNotFoundError):
            # Fall back to a relative path — useful when the module is not
            # installed as a package (local pytest runs).
            here = Path(__file__).resolve().parent
            fallback = here / "dictionaries" / filename
            data = json.loads(fallback.read_text(encoding="utf-8"))
        return cls(language, data)


def to_sign_id(language: str, gloss: str) -> str:
    """Build a canonical sign ID from a language + gloss label.

    e.g. ("ASL", "THANK-YOU") -> "asl-thank-you-v1"
    Matches the pattern in backend/events/sign-id.json.
    """
    slug = _slug(gloss)
    return f"{language.lower()}-{slug}-{DICTIONARY_VERSION}"


def _slug(gloss: str) -> str:
    """Lowercase and collapse every non-alphanumeric run into a single hyphen.

    This MUST match the slug the clip converter uses to name files
    (pose-generator/src/openpose_to_dictionary.py), otherwise the sign id we
    emit will not resolve to a clip. Punctuation matters here: the gloss
    `DR._HILLA_LIMAN` has to become `dr-hilla-liman`, not `dr.-hilla-liman`.
    """
    return re.sub(r"[^a-z0-9]+", "-", gloss.lower()).strip("-")


def map_tokens(
    tokens: Iterable[str],
    dictionary: Dictionary,
    alphabet: frozenset[str] | None = None,
    spellable: set[str] | None = None,
) -> list[MappedSign]:
    """Greedy longest-match: walk the tokens once, emit one sign per match.

    `alphabet` enables fingerspelling for words with no sign — names, brands,
    technical terms — which is what a human interpreter does with them. It is
    the set of letters the language can actually sign; a word is spelled only
    if EVERY one of its letters is in it, because a guessed handshape is a
    wrong letter rather than an approximate one. Omit it to disable spelling.

    `spellable` restricts spelling to words that look like proper nouns (see
    normaliser.proper_noun_tokens). Without it any unknown word gets spelled,
    which is both wasteful and unnatural — an interpreter who meets an
    unfamiliar ordinary word paraphrases it rather than spelling it out.
    """
    tokens = list(tokens)
    out: list[MappedSign] = []
    spelled = 0
    i = 0
    while i < len(tokens):
        matched = _match_at(tokens, i, dictionary)
        if matched is None:
            word = tokens[i]
            # No sign for this word — spell it, if we can do so completely and
            # have not already spent this utterance's spelling budget.
            #
            # Function words are never spelled, even though they reach here
            # unmatched. Signed languages do not have articles or copulas at
            # all, so spelling "THE" letter by letter does not translate the
            # sentence — it inserts something no signer would produce, and
            # spends three letter-clips doing it. The skip below only fires for
            # words that DID match a gloss, so this is the only place an
            # unmatched function word can be caught.
            if (
                alphabet
                and word not in _SKIPPED_TOKENS
                and spelled < MAX_SPELLED_PER_UTTERANCE
                and (spellable is None or word in spellable)
            ):
                fs = spell(word, dictionary.language, alphabet)
                if fs is not None:
                    log.debug("fingerspelling %r", word)
                    spelled += 1
                    out.extend(
                        MappedSign(
                            gloss=letter.upper(),
                            sign_id=sign_id,
                            source_tokens=(word,),
                            is_fingerspell=True,
                        )
                        for letter, sign_id in zip(fs.word, fs.sign_ids)
                    )
                    i += 1
                    continue
            log.debug("no gloss for token %r", word)
            i += 1
            continue
        length, gloss = matched
        # Drop function words only when they stand alone. A multi-token match
        # is never skipped: "thank you" contains no filler, but "a lot" and
        # "to be" would be destroyed by filtering their parts individually,
        # which is exactly why this check happens *after* phrase matching.
        if length == 1 and tokens[i] in _SKIPPED_TOKENS:
            log.debug("skipping function word %r", tokens[i])
            i += 1
            continue
        window = tuple(tokens[i : i + length])
        out.append(
            MappedSign(
                gloss=gloss,
                sign_id=to_sign_id(dictionary.language, gloss),
                source_tokens=window,
            )
        )
        i += length
    return out


def _match_at(
    tokens: list[str], start: int, dictionary: Dictionary
) -> tuple[int, str] | None:
    """Try the longest possible phrase at `start` first, then shorter ones."""
    max_len = min(_MAX_PHRASE_LEN, len(tokens) - start)
    for length in range(max_len, 0, -1):
        phrase = " ".join(tokens[start : start + length])
        gloss = dictionary.lookup(phrase)
        if gloss is not None:
            return length, gloss
    return None
