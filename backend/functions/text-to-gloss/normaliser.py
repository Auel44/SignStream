"""Text normalisation for gloss mapping.

The ASR gives us free-form English. Before we can look words up in the
dictionary we standardise the text: lowercase, drop punctuation, expand
common contractions ("don't" -> "do not") so a single dictionary entry can
cover both spellings.

Kept small and dependency-free so it can also run in the client one day
if we ever want to preview glosses locally.
"""

from __future__ import annotations

import re
import unicodedata

# Common English contractions. Extend as new patterns appear in real audio.
_CONTRACTIONS: dict[str, str] = {
    "can't": "can not",
    "cannot": "can not",
    "won't": "will not",
    "shan't": "shall not",
    "n't": " not",
    "'re": " are",
    "'ve": " have",
    "'ll": " will",
    "'d": " would",
    "'m": " am",
    "'s": " is",
    "let's": "let us",
    "it's": "it is",
    "that's": "that is",
    "what's": "what is",
    "there's": "there is",
    "gonna": "going to",
    "wanna": "want to",
    "gotta": "got to",
}

# After contraction expansion runs, any remaining non-word / non-space /
# non-hyphen character is replaced with a space. Hyphens are kept because
# dictionary keys like "thank-you" may come from ASR as "thank-you". Any
# leftover apostrophes (e.g. inside "o'clock" that wasn't in our contraction
# table) are stripped so unknown words don't carry punctuation.
_STRIP_RE = re.compile(r"[^\w\s-]", re.UNICODE)
_WHITESPACE_RE = re.compile(r"\s+")


def normalise(text: str) -> str:
    """Return a cleaned, lowercase, contraction-free version of the text."""
    if not text:
        return ""

    # Fold accented characters to their ASCII base so "café" matches "cafe".
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))

    text = text.lower()

    # Expand multi-character contractions first so single-char patterns
    # ("'s", "'ll") do not swallow them prematurely.
    for long_form_key in ("cannot", "let's", "it's", "that's", "what's",
                           "there's", "gonna", "wanna", "gotta",
                           "can't", "won't", "shan't"):
        text = text.replace(long_form_key, _CONTRACTIONS[long_form_key])

    for short_form_key in ("n't", "'re", "'ve", "'ll", "'d", "'m", "'s"):
        text = text.replace(short_form_key, _CONTRACTIONS[short_form_key])

    text = _STRIP_RE.sub(" ", text)
    text = _WHITESPACE_RE.sub(" ", text).strip()

    return text


def tokenise(text: str) -> list[str]:
    """Split normalised text into space-separated tokens."""
    normalised = normalise(text)
    if not normalised:
        return []
    return normalised.split(" ")


# Detects a word that is almost certainly a name, brand or technical term:
#   * an internal capital  — AirPods, iPhone, McDonald, GhSL
#   * ALL CAPS of length>1 — NASA, HIV
#   * a leading capital    — Kofi, Accra (only trusted away from position 0)
_INTERNAL_CAP = re.compile(r"^[A-Za-z][a-z]*[A-Z]")
_ALL_CAPS = re.compile(r"^[A-Z]{2,}$")
_LEADING_CAP = re.compile(r"^[A-Z][a-z]+$")


def proper_noun_tokens(text: str) -> set[str]:
    """Normalised tokens that look like proper nouns in the ORIGINAL text.

    Fingerspelling is for words a signer cannot sign — names, places, brands,
    technical terms. Spelling ordinary vocabulary instead is both wasteful and
    unnatural: an interpreter meeting an unfamiliar common word paraphrases it,
    they do not spell it out letter by letter.

    Capitalisation is the only signal available here, and it survives into this
    function precisely because `normalise` has not been applied yet. A
    sentence-initial capital is ignored — "Ever tried" starts with a capital
    but "ever" is not a name — unless the word carries a stronger marker such
    as an internal capital or being all upper case.
    """
    out: set[str] = set()
    for index, raw in enumerate(text.split()):
        word = raw.strip(".,!?;:\"'()[]{}")
        if not word:
            continue
        strong = bool(_INTERNAL_CAP.match(word) or _ALL_CAPS.match(word))
        # A leading capital only counts away from the start of the text, where
        # it would just be normal sentence casing.
        weak = index > 0 and bool(_LEADING_CAP.match(word))
        if strong or weak:
            token = normalise(word)
            if token:
                out.add(token)
    return out
