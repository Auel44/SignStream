#!/usr/bin/env python3
"""Record which letters each language can fingerspell, for the Lambda to read.

Why a generated file rather than a lookup
-----------------------------------------
`fingerspell.load_alphabet` derives the alphabet from the clips that actually
exist, which is the right rule: a letter is spellable once its keypoints are on
the CDN, and never before. The dev gateway can apply that rule directly because
it has `dictionary/` mounted.

The text-to-gloss Lambda does not. It bundles only the gloss vocabulary
(`dictionaries/<lang>.json`); the clips live in S3 behind CloudFront and are
fetched by the *browser*, not by the Lambda. So the Lambda has no way to see
which letter clips exist, and passed no alphabet at all — which silently
disabled fingerspelling in production while it worked in local dev.

This script closes that gap by snapshotting the answer at build time into
`dictionaries/alphabets.json`, next to the vocabularies the Lambda already
ships. Run it whenever letter clips are added or removed:

    python backend/scripts/build-alphabets.py

Then redeploy the Lambda. A stale snapshot fails safe in one direction and not
the other, which is worth knowing:

  * A letter present on disk but missing here — that word is not spelled.
    Conservative, and the caption still carries it.
  * A letter listed here but missing from the CDN — the avatar requests a clip
    that 404s and skips the letter, so a word is spelled with a hole in it.
    That is a wrong word rendered confidently, so re-run this after any change
    that removes clips.
"""

from __future__ import annotations

import json
import string
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLIPS = REPO / "dictionary"
OUT = REPO / "backend/functions/text-to-gloss/dictionaries/alphabets.json"

#: Mirrors mapper.VALID_LANGUAGES. BSL is deliberately absent — it has no
#: keypoint dataset, so promising fingerspelling for it would promise a
#: translation that cannot be performed.
LANGUAGES = {"asl": "ASL", "ghsl": "GhSL"}


def letters_for(clip_dir: Path) -> str:
    """The letters with a clip on disk, in alphabetical order."""
    if not clip_dir.is_dir():
        return ""
    return "".join(
        ch for ch in string.ascii_lowercase if (clip_dir / f"{ch}-v1.json").is_file()
    )


def main() -> int:
    manifest: dict[str, str] = {}
    for folder, canonical in sorted(LANGUAGES.items()):
        found = letters_for(CLIPS / folder)
        manifest[canonical] = found
        missing = [c for c in string.ascii_lowercase if c not in found]
        state = "complete" if not missing else f"missing {', '.join(missing)}"
        print(f"  {canonical:<5} {len(found):2d}/26  {state}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"\nwrote {OUT.relative_to(REPO)}")

    if all(len(v) < 26 for v in manifest.values()):
        print("\nNo language can fingerspell yet - every one is short of 26 letters.")
        print("A word is only spelled when EVERY letter in it has a clip, so a")
        print("partial alphabet spells nothing rather than spelling badly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
