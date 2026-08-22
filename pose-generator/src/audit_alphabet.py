"""Report which manual-alphabet letters each language can actually sign.

Fingerspelling is refused unless every letter of a word is available, because a
guessed handshape is a wrong letter rather than an approximate one. This tells
you exactly how far each language is from being able to spell, and what is
missing.

    python audit_alphabet.py
    python audit_alphabet.py --language ghsl
"""

from __future__ import annotations

import argparse
import json
import string
import sys
from pathlib import Path

#: Letters weighted by English frequency, so "missing 6" is reported in terms
#: of how much it actually costs rather than as a bare count.
ENGLISH_LETTER_FREQ = {
    "e": 12.7, "t": 9.1, "a": 8.2, "o": 7.5, "i": 7.0, "n": 6.7, "s": 6.3,
    "h": 6.1, "r": 6.0, "d": 4.3, "l": 4.0, "c": 2.8, "u": 2.8, "m": 2.4,
    "w": 2.4, "f": 2.2, "g": 2.0, "y": 2.0, "p": 1.9, "b": 1.5, "v": 1.0,
    "k": 0.8, "j": 0.15, "x": 0.15, "q": 0.10, "z": 0.07,
}


def audit(clips_dir: Path, language: str) -> tuple[list[str], list[str]]:
    have, missing = [], []
    for ch in string.ascii_lowercase:
        path = clips_dir / f"{ch}-v1.json"
        ok = False
        if path.exists():
            try:
                clip = json.loads(path.read_text(encoding="utf-8"))
                # A letter clip must have real frames to be usable.
                ok = bool(clip.get("frames"))
            except Exception:  # noqa: BLE001
                ok = False
        (have if ok else missing).append(ch)
    return have, missing


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--language", default=None, choices=["asl", "ghsl"])
    args = p.parse_args()

    root = Path(__file__).resolve().parents[2] / "dictionary"
    languages = [args.language] if args.language else ["asl", "ghsl"]

    for lang in languages:
        clips = root / lang
        if not clips.is_dir():
            print(f"{lang}: no clips directory")
            continue
        have, missing = audit(clips, lang)
        covered = sum(ENGLISH_LETTER_FREQ.get(c, 0) for c in have)

        print(f"\n{lang.upper()}")
        print(f"  letters available : {len(have)}/26")
        print(f"  text coverage     : {covered:.0f}% of English letter usage")
        if missing:
            print(f"  MISSING           : {', '.join(missing)}")
            print("  -> cannot fingerspell: any word containing a missing letter is skipped")
        else:
            print("  -> full alphabet, fingerspelling available")

    print()
    print("Fingerspelling turns on per language as soon as all 26 clips exist;")
    print("no code change is needed. Add them to dictionary/<lang>/<letter>-v1.json")
    print("in the same schema as every other clip.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
