#!/usr/bin/env python3
"""Reuse one language's manual alphabet as another's.

Why this is linguistics, not a shortcut
---------------------------------------
Deaf education in Ghana began in 1957 under Andrew Foster, who brought ASL
with him. Ghanaian Sign Language grew from that root: it has its own lexicon,
but its **manual alphabet is the ASL one** — one-handed, same handshapes, with
22 distinct shapes covering 26 letters (h/u, k/p and g/l share a shape and are
separated by movement or orientation).

So a GhSL signer fingerspelling a name makes the same handshapes an ASL signer
does. Copying the letter clips across is not an approximation standing in for
missing data; it is the same data, correctly reused.

What this does NOT claim
------------------------
Only the alphabet transfers. Nothing here copies lexical signs — GhSL's
vocabulary is its own and lives in its own dictionary. The copy is restricted
to single-letter clips for exactly that reason.

Each written clip records `derivedFrom`, so the provenance survives in the file
itself. Without it a later reader would have no way to tell these apart from
clips recorded by a Ghanaian signer, and would have no reason to doubt them.

Usage
-----
    python src/copy_alphabet.py --from ASL --to GhSL
    python src/copy_alphabet.py --from ASL --to GhSL --dry-run
    python src/copy_alphabet.py --from ASL --to GhSL --force
"""

from __future__ import annotations

import argparse
import json
import string
import sys
from pathlib import Path

#: The clip filename for a single letter, e.g. `b-v1.json`.
LETTER_GLOB = "{letter}-v1.json"

#: Canonical casing per language, because `language` is a display field that
#: the extension shows and the sign id is built from its lowercase form.
CANONICAL = {"asl": "ASL", "ghsl": "GhSL", "bsl": "BSL"}


def canonical(language: str) -> str:
    return CANONICAL.get(language.lower(), language)


def copy_letter(src: Path, dst: Path, source_lang: str, target_lang: str) -> dict:
    """Rewrite one letter clip for the target language.

    Only the three identity fields change. The keypoints, timing, joint order
    and `source` are left exactly as they are: `source` in particular must stay
    `openpose-2d`, because the renderer keys its depth correction off that value
    and a 2D clip that claims otherwise would be signed flat inside the chest.
    """
    clip = json.loads(src.read_text(encoding="utf-8"))

    original_id = clip["signId"]
    gloss = clip["gloss"]

    clip["signId"] = f"{target_lang.lower()}-{gloss.lower()}-v1"
    clip["language"] = target_lang
    # Provenance, so nobody later mistakes this for a Ghanaian recording.
    clip["derivedFrom"] = original_id
    clip["derivedNote"] = (
        f"{target_lang} uses the {source_lang} manual alphabet; "
        "lexical signs are not shared."
    )

    dst.write_text(json.dumps(clip, separators=(",", ":")), encoding="utf-8")
    return clip


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--from", dest="source", default="ASL", help="language to copy from")
    p.add_argument("--to", dest="target", default="GhSL", help="language to copy to")
    p.add_argument("--force", action="store_true", help="overwrite existing letters")
    p.add_argument("--dry-run", action="store_true", help="report without writing")
    args = p.parse_args()

    source_lang = canonical(args.source)
    target_lang = canonical(args.target)
    if source_lang == target_lang:
        print("--from and --to are the same language", file=sys.stderr)
        return 2

    root = Path(__file__).resolve().parents[2] / "dictionary"
    src_dir = root / source_lang.lower()
    dst_dir = root / target_lang.lower()
    if not src_dir.is_dir():
        print(f"no clips for {source_lang}: {src_dir}", file=sys.stderr)
        return 1
    dst_dir.mkdir(parents=True, exist_ok=True)

    copied, skipped, missing = [], [], []
    for letter in string.ascii_lowercase:
        src = src_dir / LETTER_GLOB.format(letter=letter)
        dst = dst_dir / LETTER_GLOB.format(letter=letter)
        if not src.is_file():
            missing.append(letter)
            continue
        if dst.is_file() and not args.force:
            skipped.append(letter)
            continue
        if not args.dry_run:
            copy_letter(src, dst, source_lang, target_lang)
        copied.append(letter)

    verb = "would copy" if args.dry_run else "copied"
    print(f"{source_lang} -> {target_lang}")
    print(f"  {verb:<10}  {len(copied):2d}  {' '.join(copied)}")
    if skipped:
        print(f"  {'skipped':<10}  {len(skipped):2d}  {' '.join(skipped)} (exists; --force to replace)")
    if missing:
        print(f"  {'missing':<10}  {len(missing):2d}  {' '.join(missing)}  <- not in {source_lang} either")
        print()
        print(f"  {target_lang} fingerspelling stays OFF until all 26 exist -")
        print(f"  a missing letter means any word containing it is skipped entirely.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
