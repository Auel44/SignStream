"""Convert WLASL OpenPose keypoints into ASL dictionary clips.

WLASL stores keypoints as OpenPose per-frame JSON — the SAME format as the GhSL
lexicon — under `data/pose_per_individual_videos/<video_id>/`, and maps each
gloss (word) to a list of `video_id`s in `WLASL_v0.3.json`. Each gloss has many
instances (~21 different signers); for a dictionary we want ONE clip per word.

Why we score instead of taking the first instance
-------------------------------------------------
The GhSL dataset was purpose-built, so every folder is usable. WLASL is scraped
from public ASL videos of wildly varying quality. On the low-resolution or
motion-blurred ones OpenPose returns all-zero hand keypoints — which yields a
clip where the avatar's arms swing but the fingers never move. For a signer
that is worse than showing nothing, because the handshape IS the word.

So we sample a few frames from each candidate and keep the best:

    60%  fraction of hand points detected      (handshape carries the meaning)
    25%  fraction of frames with both wrists   (arm trajectory)
    15%  fraction of frames with neck+shoulders (required to normalise at all)

Scoring reads only a handful of frames per candidate, so it costs far less than
the full conversion it protects.

Usage
-----
    python wlasl_to_dictionary.py --wlasl-root ../../WLASL --output-root ../../dictionary/asl
    python wlasl_to_dictionary.py --wlasl-root ../../WLASL --output-root ../../dictionary/asl --dry-run
    python wlasl_to_dictionary.py --wlasl-root ../../WLASL --output-root ../../dictionary/asl --limit 20

Prerequisite: the keypoints must be downloaded (they are NOT in the git clone).
See the WLASL README — the body-keypoints Google Drive archive unzips into
`WLASL/data/pose_per_individual_videos/`.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from openpose_to_dictionary import (  # noqa: E402
    CONF_MIN,
    FRAME_RE,
    L_SHOULDER,
    NECK,
    R_SHOULDER,
    convert_folder,
)

log = logging.getLogger("wlasl-to-dictionary")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# Indices into the 67-joint layout built by openpose_to_dictionary.
HANDS = slice(25, 67)
R_WRIST, L_WRIST = 4, 7

# Candidates to score per gloss. WLASL averages ~21 instances; scoring them all
# would multiply the runtime for a negligible quality gain.
MAX_CANDIDATES = 8

# Frames sampled when scoring one candidate.
SCORE_SAMPLES = 8

# Shorter than this and the recording is truncated, not a sign.
MIN_FRAMES = 8

# Stop scoring a gloss's remaining candidates once one is this good. Most first
# candidates already clear it, which cuts the full 2000-gloss pass by roughly
# half; the clips above this threshold are indistinguishable in practice.
GOOD_ENOUGH = 0.90


def _find_labels(root: Path) -> Path:
    for cand in (root / "start_kit" / "WLASL_v0.3.json", root / "WLASL_v0.3.json"):
        if cand.exists():
            return cand
    raise SystemExit(f"WLASL_v0.3.json not found under {root}")


def _find_pose_root(root: Path) -> Path:
    for cand in (
        root / "data" / "pose_per_individual_videos",
        root / "pose_per_individual_videos",
    ):
        if cand.is_dir():
            return cand
    raise SystemExit(
        "pose_per_individual_videos/ not found — download the WLASL body "
        "keypoints first (they are not part of the git clone) and unzip them "
        "into WLASL/data/."
    )


def _frame_files(folder: Path) -> list[Path]:
    """Frame files in the folder, ordered by frame number."""
    files = []
    for fp in folder.glob("*_keypoints.json"):
        m = FRAME_RE.search(fp.name)
        if m:
            files.append((int(m.group(1)), fp))
    files.sort(key=lambda t: t[0])
    return [fp for _, fp in files]


def _apply_range(files: list[Path], frame_range: tuple[int, int] | None) -> list[Path]:
    if frame_range is None:
        return files
    start, end = frame_range
    lo = max(0, start - 1)
    hi = len(files) if end <= 0 else min(len(files), end)
    return files[lo:hi] if lo < hi else files


def _confidences(fp: Path) -> list[float] | None:
    """The 67 per-joint confidences for one frame, or None if unreadable."""
    try:
        people = json.loads(fp.read_text(encoding="utf-8")).get("people") or []
    except Exception:  # noqa: BLE001
        return None
    if not people:
        return None
    person = people[0]

    def conf(key: str, n: int) -> list[float]:
        vals = person.get(key) or []
        out = [vals[i + 2] for i in range(0, len(vals), 3)]
        return (out + [0.0] * n)[:n]

    return (
        conf("pose_keypoints_2d", 25)
        + conf("hand_left_keypoints_2d", 21)
        + conf("hand_right_keypoints_2d", 21)
    )


def score_folder(folder: Path, frame_range: tuple[int, int] | None = None) -> float:
    """0.0-1.0 quality estimate for a candidate pose folder. 0.0 = unusable."""
    files = _apply_range(_frame_files(folder), frame_range)
    if len(files) < MIN_FRAMES:
        return 0.0

    step = max(1, len(files) // SCORE_SAMPLES)
    sampled = files[::step][:SCORE_SAMPLES]

    hand_fracs: list[float] = []
    wrists_ok = torso_ok = counted = 0
    for fp in sampled:
        c = _confidences(fp)
        if c is None:
            continue
        counted += 1
        hands = c[HANDS]
        hand_fracs.append(sum(1 for v in hands if v > CONF_MIN) / len(hands))
        if c[R_WRIST] > CONF_MIN and c[L_WRIST] > CONF_MIN:
            wrists_ok += 1
        if c[NECK] > CONF_MIN and c[R_SHOULDER] > CONF_MIN and c[L_SHOULDER] > CONF_MIN:
            torso_ok += 1

    # Without a confident neck + shoulders the clip cannot be normalised at all.
    if not counted or not torso_ok:
        return 0.0

    return (
        0.60 * (sum(hand_fracs) / len(hand_fracs))
        + 0.25 * (wrists_ok / counted)
        + 0.15 * (torso_ok / counted)
    )


def resolve_range(instance: dict, n_on_disk: int) -> tuple[int, int] | None:
    """Which disk frames belong to this instance, or None for "all of them".

    WLASL is inconsistent here. For some video ids the pose folder was already
    trimmed to the instance — frame_start is in the thousands yet the folder
    holds exactly frame_end - frame_start + 1 frames. For others the folder
    holds a longer recording and the range really is a slice. Telling them
    apart by frame count is the only reliable signal.
    """
    start = instance.get("frame_start", 1) or 1
    end = instance.get("frame_end", -1)
    if not end or end <= 0:
        return None
    if end - start + 1 == n_on_disk:
        return None            # already trimmed — take everything
    if end <= n_on_disk:
        return (start, end)    # genuine slice of a longer recording
    return None                # range indexes a video we don't have; take all


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--wlasl-root", required=True, help="Path to the cloned WLASL repo.")
    p.add_argument("--output-root", required=True, help="e.g. ../dictionary/asl")
    p.add_argument("--language", default="ASL", choices=["ASL", "GhSL"])
    p.add_argument("--version", default="v1")
    p.add_argument("--fps", type=float, default=25.0, help="WLASL is uniformly 25fps.")
    p.add_argument("--force", action="store_true", help="Overwrite existing clips.")
    p.add_argument("--limit", type=int, default=0, help="Only the first N glosses (0 = all).")
    p.add_argument("--min-score", type=float, default=0.15,
                   help="Drop a gloss when even its best instance scores below this.")
    p.add_argument("--dry-run", action="store_true", help="Score and report, write nothing.")
    args = p.parse_args()

    root = Path(args.wlasl_root)
    labels_path = _find_labels(root)
    pose_root = _find_pose_root(root)
    output_root = Path(args.output_root)

    entries = json.loads(labels_path.read_text(encoding="utf-8"))
    if args.limit:
        entries = entries[: args.limit]
    available = {d.name for d in pose_root.iterdir() if d.is_dir()}
    log.info("%d glosses; %d pose folders under %s", len(entries), len(available), pose_root)

    written = no_keypoints = rejected = 0
    scores: list[float] = []
    for i, entry in enumerate(entries, 1):
        gloss = entry["gloss"]
        candidates = [c for c in entry.get("instances", []) if str(c["video_id"]) in available]
        if not candidates:
            no_keypoints += 1
            continue

        best: tuple[float, dict, tuple[int, int] | None] | None = None
        for inst in candidates[:MAX_CANDIDATES]:
            folder = pose_root / str(inst["video_id"])
            rng = resolve_range(inst, len(_frame_files(folder)))
            s = score_folder(folder, rng)
            if best is None or s > best[0]:
                best = (s, inst, rng)
            if best[0] >= GOOD_ENOUGH:
                break

        assert best is not None
        score, inst, rng = best
        if score < args.min_score:
            log.warning("%s: best of %d instances scores %.2f — dropped",
                        gloss, len(candidates), score)
            rejected += 1
            continue

        scores.append(score)
        if args.dry_run:
            log.info("%s <- %s (score %.2f)", gloss, inst["video_id"], score)
            written += 1
        elif convert_folder(pose_root / str(inst["video_id"]), output_root,
                            args.language, args.version, args.fps, args.force,
                            gloss=gloss, frame_range=rng):
            written += 1
        else:
            rejected += 1

        if i % 200 == 0:
            log.info("... %d/%d glosses processed", i, len(entries))

    log.info("clips written     : %d", written)
    log.info("no keypoints      : %d", no_keypoints)
    log.info("rejected (quality): %d", rejected)
    if scores:
        log.info("mean score        : %.2f", sum(scores) / len(scores))
    log.info("output            : %s", output_root)
    return 0 if written else 1


if __name__ == "__main__":
    sys.exit(main())
