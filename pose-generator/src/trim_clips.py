"""Trim the dead air from dictionary clips.

Why
---
Each clip was recorded as a single word performed in isolation: the signer
starts at rest, raises their hands, makes the sign, and lowers them again. The
raising and lowering carry no meaning, but they are played back in full — so a
GhSL clip runs ~4.5 s when the sign itself is nearer 2 s.

That is not a cosmetic problem. Speech runs at roughly 2-3 words per second;
at 4.5 s per sign the avatar can perform about 0.22 signs per second, so it
falls behind continuously and the backlog grows for as long as the video plays.
Trimming is the single largest lever on how much signing can actually be shown.

How
---
**Hand height**, not movement, marks where the sign starts and ends.

Movement is the obvious signal but the wrong one: raising the hands from the
lap is itself a large, fast motion, so a motion detector keeps most of the
very dead air it is supposed to remove. Height separates them cleanly. Measured
across the GhSL set, the wrists sit at a flat ~-0.50 (neck-relative, Y-up)
whenever the signer is at rest, and rise to between -0.25 and +0.20 during the
sign — and the first and last frames sit at *exactly* the rest value, because
the signer is holding still before and after.

So: take the higher wrist per frame, find that clip's own rest level and peak,
and keep the span above a fraction of the way between them. The threshold is
relative because signing height varies by sign and by signer.

A few signs are performed low, near the waist, where height barely moves. Those
are detected (the rise is tiny) and fall back to the motion signal so they are
never mangled.

A short pad is kept either side so the sign does not begin or end mid-gesture,
and clips are never trimmed below `--min-duration`.

Usage
-----
    python trim_clips.py --language ghsl --dry-run     # report only
    python trim_clips.py --language ghsl               # rewrite in place
    python trim_clips.py --language ghsl --backup      # keep .orig copies
"""

from __future__ import annotations

import argparse
import json
import logging
import statistics
import sys
from pathlib import Path

log = logging.getLogger("trim-clips")
logging.basicConfig(level=logging.INFO, format="%(message)s")

# Joints that carry the meaning of a sign. Body/leg points drift with posture
# and would muddy the motion signal; the hands are the sign.
WRISTS = ("r_wrist", "l_wrist")
HAND_PREFIXES = ("l_hand_", "r_hand_")

#: How far up from rest towards the peak counts as "the sign has begun".
HEIGHT_FRACTION = 0.18
#: Movement above this fraction of peak, used only when height is unusable.
ACTIVITY_FRACTION = 0.12
#: A clip whose wrists rise less than this (metres) is signed at rest height,
#: so the height signal carries no information and motion is used instead.
MIN_HEIGHT_RISE = 0.08
#: Frames of context kept either side of the detected span.
PAD_FRAMES = 2
#: Window for smoothing the per-frame signals.
SMOOTH_WINDOW = 3


def meaningful_indices(joints: list[str]) -> list[int]:
    return [
        i
        for i, name in enumerate(joints)
        if name in WRISTS or name.startswith(HAND_PREFIXES)
    ]


def motion_profile(clip: dict, indices: list[int]) -> list[float]:
    """Per-frame movement of the meaningful joints since the previous frame."""
    frames = clip["frames"]
    profile = [0.0]
    for prev, cur in zip(frames, frames[1:]):
        deltas = []
        for i in indices:
            a, b = prev["positions"][i], cur["positions"][i]
            # [0,0,0] means the joint was not tracked in that frame; a jump to
            # or from it is a detection artefact, not movement.
            if (a[0] == 0 and a[1] == 0) or (b[0] == 0 and b[1] == 0):
                continue
            deltas.append(((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5)
        profile.append(statistics.fmean(deltas) if deltas else 0.0)
    return profile


def smooth(values: list[float], window: int) -> list[float]:
    if window <= 1 or len(values) < window:
        return values
    half = window // 2
    out = []
    for i in range(len(values)):
        lo, hi = max(0, i - half), min(len(values), i + half + 1)
        out.append(statistics.fmean(values[lo:hi]))
    return out


def height_profile(clip: dict) -> list[float | None]:
    """Height of the higher wrist per frame. None when neither is tracked."""
    joints = clip["joints"]
    try:
        wrists = [joints.index(name) for name in WRISTS]
    except ValueError:
        return []
    out: list[float | None] = []
    for f in clip["frames"]:
        ys = [
            f["positions"][i][1]
            for i in wrists
            if not (f["positions"][i][0] == 0 and f["positions"][i][1] == 0)
        ]
        out.append(max(ys) if ys else None)
    return out


def _span_from(flags: list[bool], n: int) -> tuple[int, int] | None:
    active = [i for i, on in enumerate(flags) if on]
    if not active:
        return None
    return max(0, active[0] - PAD_FRAMES), min(n - 1, active[-1] + PAD_FRAMES)


def active_span(clip: dict) -> tuple[int, int] | None:
    """Inclusive (first, last) frame indices holding the sign itself."""
    frames = clip["frames"]
    if len(frames) < 4:
        return None

    # ── Preferred signal: how high the hands are ────────────────────────────
    heights = height_profile(clip)
    known = [h for h in heights if h is not None]
    if known:
        rest, peak = min(known), max(known)
        if peak - rest >= MIN_HEIGHT_RISE:
            # Carry the last known height across untracked frames rather than
            # treating them as rest — a dropped detection mid-sign must not
            # split the span.
            filled: list[float] = []
            last = rest
            for h in heights:
                last = h if h is not None else last
                filled.append(last)
            filled = smooth(filled, SMOOTH_WINDOW)
            cutoff = rest + (peak - rest) * HEIGHT_FRACTION
            span = _span_from([h >= cutoff for h in filled], len(frames))
            if span:
                return span

    # ── Fallback: signs performed at rest height, where motion is all we have
    indices = meaningful_indices(clip["joints"])
    if not indices:
        return None
    profile = smooth(motion_profile(clip, indices), SMOOTH_WINDOW)
    peak = max(profile)
    if peak <= 0:
        return None  # nothing moves — leave it alone
    threshold = peak * ACTIVITY_FRACTION
    return _span_from([v >= threshold for v in profile], len(frames))


def retime(clip: dict, first: int, last: int) -> dict:
    """Slice the clip and rebase frame timestamps to start at zero."""
    fps = clip.get("fps") or 25.0
    kept = clip["frames"][first : last + 1]
    origin = kept[0]["t"]
    clip["frames"] = [
        {"t": f["t"] - origin, "positions": f["positions"]} for f in kept
    ]
    clip["durationMs"] = int(round((len(kept) - 1) * 1000 / fps)) if len(kept) > 1 else 0
    clip["trimmed"] = True
    return clip


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--language", default="ghsl", choices=["asl", "ghsl"])
    p.add_argument("--clips-dir", default=None)
    p.add_argument("--dry-run", action="store_true", help="Report without writing.")
    p.add_argument("--backup", action="store_true", help="Keep a .orig copy of each clip.")
    p.add_argument("--min-duration", type=float, default=0.6,
                   help="Never trim a clip shorter than this many seconds.")
    args = p.parse_args()

    root = Path(args.clips_dir) if args.clips_dir else (
        Path(__file__).resolve().parents[2] / "dictionary" / args.language
    )
    paths = sorted(root.glob("*.json"))
    if not paths:
        log.error("no clips in %s", root)
        return 1

    before_ms: list[float] = []
    after_ms: list[float] = []
    skipped = written = 0

    for path in paths:
        try:
            clip = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            log.warning("unreadable %s: %s", path.name, exc)
            continue
        if clip.get("trimmed"):
            skipped += 1
            before_ms.append(clip["durationMs"])
            after_ms.append(clip["durationMs"])
            continue

        original = clip["durationMs"]
        before_ms.append(original)

        span = active_span(clip)
        fps = clip.get("fps") or 25.0
        min_frames = max(2, int(args.min_duration * fps))

        if span is None or (span[1] - span[0] + 1) < min_frames:
            after_ms.append(original)
            continue

        first, last = span
        if first == 0 and last == len(clip["frames"]) - 1:
            after_ms.append(original)
            continue

        retime(clip, first, last)
        after_ms.append(clip["durationMs"])

        if not args.dry_run:
            if args.backup:
                backup = path.with_suffix(".json.orig")
                if not backup.exists():
                    backup.write_text(json.dumps(json.loads(path.read_text(encoding="utf-8")),
                                                 separators=(",", ":")), encoding="utf-8")
            path.write_text(json.dumps(clip, separators=(",", ":")), encoding="utf-8")
        written += 1

    b_med = statistics.median(before_ms) / 1000
    a_med = statistics.median(after_ms) / 1000
    log.info("")
    log.info("clips              : %d  (%d already trimmed, skipped)", len(paths), skipped)
    log.info("would trim         : %d", written)
    log.info("median duration    : %.2fs  ->  %.2fs   (%.0f%% shorter)",
             b_med, a_med, (1 - a_med / b_med) * 100 if b_med else 0)
    log.info("mean duration      : %.2fs  ->  %.2fs",
             statistics.fmean(before_ms) / 1000, statistics.fmean(after_ms) / 1000)
    log.info("avatar throughput  : %.2f  ->  %.2f signs/sec", 1 / b_med, 1 / a_med)
    if args.dry_run:
        log.info("")
        log.info("dry run — nothing written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
