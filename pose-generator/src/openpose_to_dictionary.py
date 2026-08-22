"""Convert OpenPose keypoint folders into SignStream dictionary clips.

The GSL_openpose_data dataset stores one folder per sign (the folder name is
the word), and inside each folder is the sign's video plus one OpenPose
`*_keypoints.json` file per frame. This script reads all frames of a word IN
ORDER and packs them into a single `dictionary/<lang>/<slug>-v<n>.json` clip in
the schema the browser avatar plays.

Because the dataset already contains keypoints, we do NOT run MediaPipe here —
we convert the existing OpenPose points directly (faster, lossless).

OpenPose input per frame (BODY_25 + hands, 2D):
    pose_keypoints_2d        25 points × (x, y, confidence)
    hand_left_keypoints_2d   21 points × (x, y, confidence)
    hand_right_keypoints_2d  21 points × (x, y, confidence)

Output per clip: 25 + 21 + 21 = 67 joints, coordinates normalised to a
body-relative frame (origin at the neck, Y-up, scaled so shoulder width ≈
0.4 m). z is 0 for every point because the source data is 2D.

Usage
-----
    # one word folder
    python openpose_to_dictionary.py \
        --input .../GSL_openpose_data/ACCIDENT \
        --output-root ../dictionary/ghsl --language GhSL

    # every word folder under a root (the 1200-sign dataset)
    python openpose_to_dictionary.py \
        --batch .../GSL_openpose_data \
        --output-root ../dictionary/ghsl --language GhSL
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path
from statistics import median

log = logging.getLogger("openpose-to-dictionary")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# OpenPose BODY_25 joint names, in index order.
BODY_25_NAMES = [
    "nose", "neck", "r_shoulder", "r_elbow", "r_wrist", "l_shoulder", "l_elbow",
    "l_wrist", "mid_hip", "r_hip", "r_knee", "r_ankle", "l_hip", "l_knee",
    "l_ankle", "r_eye", "l_eye", "r_ear", "l_ear", "l_bigtoe", "l_smalltoe",
    "l_heel", "r_bigtoe", "r_smalltoe", "r_heel",
]
NECK = 1
R_SHOULDER = 2
L_SHOULDER = 5

JOINT_NAMES = (
    BODY_25_NAMES
    + [f"l_hand_{i}" for i in range(21)]
    + [f"r_hand_{i}" for i in range(21)]
)

TARGET_SHOULDER_M = 0.40  # scale so shoulder width maps to ~40 cm
CONF_MIN = 0.05           # points below this confidence are treated as missing
FRAME_RE = re.compile(r"_(\d+)_keypoints\.json$")


def _triples(vals: list[float]) -> list[tuple[float, float, float]]:
    """Chunk a flat [x,y,c,x,y,c,...] list into (x,y,c) triples."""
    return [(vals[i], vals[i + 1], vals[i + 2]) for i in range(0, len(vals), 3)]


def _frame_points(person: dict) -> list[tuple[float, float, float]]:
    """Return the 67 (x,y,confidence) points for one frame, padded if absent."""
    pose = _triples(person.get("pose_keypoints_2d", []) or [])
    lh = _triples(person.get("hand_left_keypoints_2d", []) or [])
    rh = _triples(person.get("hand_right_keypoints_2d", []) or [])
    pose += [(0.0, 0.0, 0.0)] * (25 - len(pose))
    lh += [(0.0, 0.0, 0.0)] * (21 - len(lh))
    rh += [(0.0, 0.0, 0.0)] * (21 - len(rh))
    return pose[:25] + lh[:21] + rh[:21]


def _load_frames(
    folder: Path,
    frame_range: tuple[int, int] | None = None,
) -> list[list[tuple[float, float, float]]]:
    """Load every keypoint frame in a folder, sorted by frame number.

    `frame_range` is an inclusive 1-based (start, end) slice over the frames
    present on disk. It exists for datasets like WLASL where one long source
    video contains several signs and the label file says which span belongs to
    this one. Out-of-range values are clamped rather than raising, because the
    metadata sometimes indexes the original video while the folder has already
    been trimmed.
    """
    files = []
    for fp in folder.glob("*_keypoints.json"):
        m = FRAME_RE.search(fp.name)
        if m:
            files.append((int(m.group(1)), fp))
    files.sort(key=lambda t: t[0])

    if frame_range is not None:
        start, end = frame_range
        lo = max(0, start - 1)
        hi = len(files) if end <= 0 else min(len(files), end)
        if lo < hi:
            files = files[lo:hi]

    frames: list[list[tuple[float, float, float]]] = []
    for _, fp in files:
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            log.warning("skip unreadable frame %s: %s", fp.name, exc)
            continue
        people = data.get("people") or []
        if not people:
            frames.append(_frame_points({}))  # empty frame — keeps timing
        else:
            frames.append(_frame_points(people[0]))
    return frames


def _reference(frames: list[list[tuple[float, float, float]]]) -> tuple[tuple[float, float], float]:
    """Robust neck origin + pixel→metre scale from shoulder width (medians)."""
    neck_xs, neck_ys, shoulder_widths = [], [], []
    for pts in frames:
        neck = pts[NECK]
        rs, ls = pts[R_SHOULDER], pts[L_SHOULDER]
        if neck[2] > CONF_MIN:
            neck_xs.append(neck[0])
            neck_ys.append(neck[1])
        if rs[2] > CONF_MIN and ls[2] > CONF_MIN:
            shoulder_widths.append(((rs[0] - ls[0]) ** 2 + (rs[1] - ls[1]) ** 2) ** 0.5)

    if not neck_xs or not shoulder_widths:
        raise ValueError("no confident neck/shoulder points — cannot normalise")

    origin = (median(neck_xs), median(neck_ys))
    scale = TARGET_SHOULDER_M / max(1e-6, median(shoulder_widths))
    return origin, scale


def _normalise(
    frames: list[list[tuple[float, float, float]]],
    origin: tuple[float, float],
    scale: float,
) -> list[list[list[float]]]:
    """Map each point to body-relative metres (Y-up), z=0. Missing → [0,0,0]."""
    out: list[list[list[float]]] = []
    for pts in frames:
        row: list[list[float]] = []
        for x, y, c in pts:
            if c <= CONF_MIN:
                row.append([0.0, 0.0, 0.0])
            else:
                nx = round((x - origin[0]) * scale, 4)
                ny = round(-(y - origin[1]) * scale, 4)  # flip: image y grows down
                row.append([nx, ny, 0.0])
        out.append(row)
    return out


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def convert_folder(
    folder: Path,
    output_root: Path,
    language: str,
    version: str,
    fps: float,
    force: bool,
    gloss: str | None = None,
    frame_range: tuple[int, int] | None = None,
) -> bool:
    """Convert one keypoint folder to a dictionary clip. Returns True on success.

    `gloss` overrides the word label. When None (the default) the word is taken
    from the folder name — that suits datasets like the GhSL lexicon where the
    folder IS the word. Datasets like WLASL, where the folder is a video id and
    the word comes from a separate label file, pass `gloss` explicitly.
    """
    name = gloss if gloss is not None else folder.name
    gloss = name.upper()
    slug = _slug(name)
    out_path = output_root / f"{slug}-{version}.json"
    if out_path.exists() and not force:
        log.info("skip (exists): %s", out_path.name)
        return True

    frames = _load_frames(folder, frame_range)
    if not frames:
        log.warning("no frames in %s — skipped", folder.name)
        return False

    try:
        origin, scale = _reference(frames)
    except ValueError as exc:
        log.warning("%s: %s — skipped", folder.name, exc)
        return False

    positions = _normalise(frames, origin, scale)
    duration_ms = int(round((len(frames) - 1) * 1000 / fps)) if len(frames) > 1 else 0

    clip = {
        "schemaVersion": 1,
        "signId": f"{language.lower()}-{slug}-{version}",
        "gloss": gloss,
        "language": language,
        "durationMs": duration_ms,
        "fps": round(fps, 2),
        "source": "openpose-2d",
        "joints": JOINT_NAMES,
        "frames": [
            {"t": int(round(i * 1000 / fps)), "positions": pos}
            for i, pos in enumerate(positions)
        ],
    }

    output_root.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(clip, separators=(",", ":")), encoding="utf-8")
    log.info("wrote %s (%d frames)", out_path.name, len(frames))
    return True


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--input", help="A single word folder.")
    mode.add_argument("--batch", help="Root folder containing many word folders.")
    p.add_argument("--output-root", required=True, help="e.g. ../dictionary/ghsl")
    p.add_argument("--language", required=True, choices=["ASL", "GhSL"])
    p.add_argument("--version", default="v1")
    p.add_argument("--fps", type=float, default=25.0,
                   help="Frame rate of the source videos (GSL data is typically 25).")
    p.add_argument("--force", action="store_true", help="Overwrite existing clips.")
    p.add_argument("--limit", type=int, default=0, help="Batch: convert only the first N (0 = all).")
    args = p.parse_args()

    output_root = Path(args.output_root)

    if args.input:
        ok = convert_folder(Path(args.input), output_root, args.language,
                            args.version, args.fps, args.force)
        return 0 if ok else 1

    root = Path(args.batch)
    folders = sorted(d for d in root.iterdir()
                     if d.is_dir() and any(d.glob("*_keypoints.json")))
    if args.limit:
        folders = folders[: args.limit]
    log.info("batch: %d word folders", len(folders))

    ok_count = 0
    for i, folder in enumerate(folders, 1):
        if convert_folder(folder, output_root, args.language, args.version,
                          args.fps, args.force):
            ok_count += 1
        if i % 100 == 0:
            log.info("... %d/%d done", i, len(folders))

    log.info("done: %d/%d clips written to %s", ok_count, len(folders), output_root)
    return 0 if ok_count else 1


if __name__ == "__main__":
    sys.exit(main())
