"""Generate the English→gloss vocabulary from the dictionary clips.

Why this exists
---------------
Two separate dictionaries have to agree for a sign to ever reach the screen:

  1. `backend/functions/text-to-gloss/dictionaries/<lang>.json`
     English word/phrase  ->  gloss label        (what the backend can *ask* for)
  2. `dictionary/<lang>/<slug>-v1.json`
     gloss label          ->  keypoint animation (what the client can *play*)

The vocabulary in (1) was originally hand-written as a placeholder, so it only
covered a few dozen words and some of those pointed at glosses with no clip.
Any word missing from (1) can never be signed, no matter how many clips exist.

This script rebuilds (1) directly from (2), so the two can't drift: every entry
it writes is guaranteed to resolve to a clip that exists on disk.

Gloss naming in the GSL lexicon
-------------------------------
  ACCIDENT             single word           -> "accident"
  ABSTAIN_OR_AVOID     alternatives          -> "abstain" and "avoid"
  BURKINA_FASO         multi-word phrase     -> "burkina faso"
  ACCRA_2 / BATH_1     duplicate recordings  -> skipped when a plain ACCRA exists

Usage
-----
    python build_gloss_vocabulary.py --language GhSL
    python build_gloss_vocabulary.py --language GhSL --dry-run
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path

log = logging.getLogger("build-gloss-vocabulary")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# Import the backend's own normaliser rather than reimplementing it. The mapper
# only ever looks up *normalised* tokens, so a key this script writes in any
# other form is dead on arrival. WLASL makes this concrete: its gloss
# "don't want" would be stored verbatim, but the normaliser expands "n't" to
# " not", so the lookup is for "do not want" and the entry would never fire.
sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[2] / "backend" / "functions" / "text-to-gloss"),
)
from normaliser import normalise  # noqa: E402

# Trailing `_2`, `_1` etc. mark repeat recordings of the same sign.
VARIANT_RE = re.compile(r"_\d+$")

# The mapper matches phrases up to this many tokens, so longer glosses can never
# be looked up. Kept in sync with text-to-gloss/mapper.py `_MAX_PHRASE_LEN`.
MAX_PHRASE_TOKENS = 3

# Hand-written synonyms worth keeping — natural speech rarely uses the exact
# gloss word. Only applied when the target gloss actually has a clip.
SYNONYMS: dict[str, str] = {
    "hi": "HELLO",
    "hey": "HELLO",
    "bye": "GOODBYE",
    "thanks": "THANK_YOU",
    "thank you": "THANK_YOU",
    "sorry": "SORRY",
    "yes": "YES",
    "no": "NO",
    "please": "PLEASE",
    "mum": "MOTHER",
    "mom": "MOTHER",
    "dad": "FATHER",
    "kid": "CHILD",
    "kids": "CHILDREN",
    "doctor": "DOCTOR",
    "hospital": "HOSPITAL",
    "water": "WATER",
    "food": "FOOD",
}


def repo_root() -> Path:
    """pose-generator/src/ -> repo root."""
    return Path(__file__).resolve().parents[2]


def english_keys(gloss: str) -> list[str]:
    """English phrase(s) that should map to this gloss.

    `A_OR_B` yields both alternatives; everything else yields one phrase with
    underscores turned into spaces. Every key is passed through the backend
    normaliser so it is written in exactly the form the mapper will look up.

    The token-count check runs *after* normalisation, because expansion can
    lengthen a phrase past what the mapper will try ("don't want" is two words
    but becomes the three-token "do not want").
    """
    core = VARIANT_RE.sub("", gloss)
    alternatives = core.split("_OR_") if "_OR_" in core else [core]
    keys = []
    for alt in alternatives:
        phrase = normalise(alt.replace("_", " "))
        if phrase and len(phrase.split()) <= MAX_PHRASE_TOKENS:
            keys.append(phrase)
    return keys


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--language", default="GhSL", choices=["ASL", "GhSL"])
    p.add_argument("--clips-dir", default=None, help="Defaults to dictionary/<lang>/.")
    p.add_argument("--out", default=None, help="Defaults to the text-to-gloss dictionary.")
    p.add_argument("--dry-run", action="store_true", help="Report without writing.")
    args = p.parse_args()

    root = repo_root()
    lang_dir = args.language.lower()
    clips_dir = Path(args.clips_dir) if args.clips_dir else root / "dictionary" / lang_dir
    out_path = (
        Path(args.out)
        if args.out
        else root
        / "backend"
        / "functions"
        / "text-to-gloss"
        / "dictionaries"
        / f"{lang_dir}.json"
    )

    clip_files = sorted(clips_dir.glob("*.json"))
    if not clip_files:
        log.error("no clips found in %s", clips_dir)
        return 1

    # gloss -> True for every gloss that has a clip on disk.
    available: dict[str, bool] = {}
    for path in clip_files:
        try:
            gloss = json.loads(path.read_text(encoding="utf-8"))["gloss"]
        except Exception as exc:  # noqa: BLE001
            log.warning("skipping unreadable clip %s: %s", path.name, exc)
            continue
        available[gloss] = True

    # Build English -> gloss. Plain glosses win over `_2` duplicates, so sort
    # variants last and never overwrite an existing key.
    vocabulary: dict[str, str] = {}
    skipped_variants = 0
    for gloss in sorted(available, key=lambda g: (bool(VARIANT_RE.search(g)), g)):
        if VARIANT_RE.search(gloss):
            skipped_variants += 1
            continue
        for key in english_keys(gloss):
            vocabulary.setdefault(key, gloss)

    added_synonyms = 0
    for word, gloss in SYNONYMS.items():
        if gloss in available and word not in vocabulary:
            vocabulary[word] = gloss
            added_synonyms += 1

    ordered = dict(sorted(vocabulary.items()))

    log.info("clips read           : %d", len(clip_files))
    log.info("distinct glosses     : %d", len(available))
    log.info("duplicate variants   : %d (skipped)", skipped_variants)
    log.info("synonyms added       : %d", added_synonyms)
    log.info("english entries      : %d", len(ordered))

    if args.dry_run:
        log.info("dry run — not writing. sample: %s", dict(list(ordered.items())[:5]))
        return 0

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(ordered, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    log.info("wrote %s", out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
