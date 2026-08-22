"""Extract MediaPipe Holistic keypoints from a sign video and write them
as a dictionary-format JSON clip.

Design
------
* One process = one video (or a batch). No streaming, no server.
* Reads MP4 (or anything OpenCV can decode) frame by frame.
* For each frame: run MediaPipe Holistic, pick 33 pose + 21 left-hand +
  21 right-hand landmarks (skip face mesh — the extension avatar does
  not render 468 face points).
* Re-frame coordinates: origin = midpoint of the first frame's hips,
  Y-up, metres (approx — scaled so shoulder width ≈ 0.4 m).
* Write the same JSON schema the extension's Three.js avatar reads
  (see ../../dictionary/README.md).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("extract-keypoints")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# Pose landmark indexes we keep from MediaPipe's 33-point Pose model.
POSE_LANDMARK_NAMES = [
    "nose",
    "left_eye_inner", "left_eye", "left_eye_outer",
    "right_eye_inner", "right_eye", "right_eye_outer",
    "left_ear", "right_ear",
    "mouth_left", "mouth_right",
    "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow",
    "left_wrist", "right_wrist",
    "left_pinky", "right_pinky",
    "left_index", "right_index",
    "left_thumb", "right_thumb",
    "left_hip", "right_hip",
    "left_knee", "right_knee",
    "left_ankle", "right_ankle",
    "left_heel", "right_heel",
    "left_foot_index", "right_foot_index",
]
POSE_INDEX = {name: i for i, name in enumerate(POSE_LANDMARK_NAMES)}


@dataclass
class LandmarkFrame:
    """One frame of Holistic output — pose + optional hand landmarks."""

    ts_ms: int
    pose_xyz: list[tuple[float, float, float]]        # 33 pose points
    left_hand_xyz: list[tuple[float, float, float]]   # 21 or empty
    right_hand_xyz: list[tuple[float, float, float]]  # 21 or empty


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--input", help="Path to a single input video.")
    mode.add_argument("--batch", help="Directory containing multiple input videos.")

    p.add_argument("--output", help="Output JSON path (single mode).")
    p.add_argument("--output-root", help="Output directory (batch mode).")

    p.add_argument("--gloss", help="Gloss label to write into the JSON (single mode).")
    p.add_argument("--language", required=True, choices=["ASL", "BSL", "GhSL"],
                   help="Target sign language.")
    p.add_argument("--complexity", type=int, default=1, choices=[0, 1, 2],
                   help="MediaPipe model_complexity. Use 2 for real dictionary content.")
    p.add_argument("--min-detection-confidence", type=float, default=0.5)
    p.add_argument("--min-tracking-confidence", type=float, default=0.5)
    p.add_argument("--force", action="store_true",
                   help="In batch mode, overwrite outputs that already exist.")
    return p.parse_args()


def _open_holistic(args: argparse.Namespace):
    try:
        import mediapipe as mp  # type: ignore[import-not-found]
    except ImportError:
        raise SystemExit(
            "mediapipe not installed. Run: pip install -r requirements.txt"
        )
    return mp.solutions.holistic.Holistic(
        static_image_mode=False,
        model_complexity=args.complexity,
        smooth_landmarks=True,
        min_detection_confidence=args.min_detection_confidence,
        min_tracking_confidence=args.min_tracking_confidence,
    )


def _read_frames(video_path: Path):
    try:
        import cv2  # type: ignore[import-not-found]
    except ImportError:
        raise SystemExit(
            "opencv-python not installed. Run: pip install -r requirements.txt"
        )
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise SystemExit(f"could not open video: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_index = 0
    while True:
        ok, frame_bgr = cap.read()
        if not ok:
            break
        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        ts_ms = int(frame_index * 1000 / fps)
        yield ts_ms, frame_rgb
        frame_index += 1
    cap.release()


def _to_xyz(landmarks, count: int) -> list[tuple[float, float, float]]:
    if landmarks is None:
        return []
    return [(lm.x, lm.y, lm.z) for lm in landmarks.landmark[:count]]


def _extract_frames(video_path: Path, holistic) -> list[LandmarkFrame]:
    out: list[LandmarkFrame] = []
    for ts_ms, frame in _read_frames(video_path):
        result = holistic.process(frame)
        out.append(LandmarkFrame(
            ts_ms=ts_ms,
            pose_xyz=_to_xyz(result.pose_landmarks, 33),
            left_hand_xyz=_to_xyz(result.left_hand_landmarks, 21),
            right_hand_xyz=_to_xyz(result.right_hand_landmarks, 21),
        ))
    return out


def _rescale(frames: list[LandmarkFrame]) -> None:
    """Rewrite all coordinates so origin = first-frame hip midpoint,
    y flipped to Y-up, and scaled so shoulder width ≈ 0.4 m."""
    if not frames or not frames[0].pose_xyz:
        return

    p0 = frames[0].pose_xyz
    left_hip = p0[POSE_INDEX["left_hip"]]
    right_hip = p0[POSE_INDEX["right_hip"]]
    origin = ((left_hip[0] + right_hip[0]) / 2,
              (left_hip[1] + right_hip[1]) / 2,
              (left_hip[2] + right_hip[2]) / 2)

    left_shoulder = p0[POSE_INDEX["left_shoulder"]]
    right_shoulder = p0[POSE_INDEX["right_shoulder"]]
    shoulder_dx = right_shoulder[0] - left_shoulder[0]
    shoulder_dy = right_shoulder[1] - left_shoulder[1]
    shoulder_dz = right_shoulder[2] - left_shoulder[2]
    shoulder_width_norm = max(
        1e-6,
        (shoulder_dx ** 2 + shoulder_dy ** 2 + shoulder_dz ** 2) ** 0.5,
    )
    scale = 0.40 / shoulder_width_norm  # target 40 cm

    def remap(triple: tuple[float, float, float]) -> tuple[float, float, float]:
        x = (triple[0] - origin[0]) * scale
        # MediaPipe y grows downward — flip for Y-up.
        y = -(triple[1] - origin[1]) * scale
        z = (triple[2] - origin[2]) * scale
        return (round(x, 4), round(y, 4), round(z, 4))

    for frame in frames:
        frame.pose_xyz = [remap(p) for p in frame.pose_xyz]
        frame.left_hand_xyz = [remap(p) for p in frame.left_hand_xyz]
        frame.right_hand_xyz = [remap(p) for p in frame.right_hand_xyz]


def _to_clip_json(
    *,
    frames: list[LandmarkFrame],
    gloss: str,
    language: str,
    fps: float,
) -> dict:
    """Serialise the extracted frames to the dictionary/*.json schema."""
    joints = list(POSE_LANDMARK_NAMES)
    joints += [f"left_hand_{i}" for i in range(21)]
    joints += [f"right_hand_{i}" for i in range(21)]

    def frame_positions(f: LandmarkFrame) -> list[list[float]]:
        pos: list[list[float]] = []
        # 33 pose landmarks, always present
        for xyz in (f.pose_xyz or [(0.0, 0.0, 0.0)] * 33):
            pos.append(list(xyz))
        # 21 left-hand
        left = f.left_hand_xyz or [(0.0, 0.0, 0.0)] * 21
        for xyz in left:
            pos.append(list(xyz))
        # 21 right-hand
        right = f.right_hand_xyz or [(0.0, 0.0, 0.0)] * 21
        for xyz in right:
            pos.append(list(xyz))
        return pos

    slug = gloss.lower().replace(" ", "-").replace("_", "-")
    sign_id = f"{language.lower()}-{slug}-v1"

    total_ms = frames[-1].ts_ms if frames else 0

    return {
        "schemaVersion": 1,
        "signId": sign_id,
        "gloss": gloss,
        "language": language,
        "durationMs": total_ms,
        "fps": round(fps, 2),
        "joints": joints,
        "frames": [
            {"t": f.ts_ms, "positions": frame_positions(f)}
            for f in frames
        ],
    }


def _process_one(
    *,
    video_path: Path,
    output_path: Path,
    gloss: str,
    language: str,
    args: argparse.Namespace,
) -> None:
    log.info("processing %s → %s", video_path, output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    holistic = _open_holistic(args)
    try:
        frames = _extract_frames(video_path, holistic)
    finally:
        holistic.close()

    if not frames:
        log.error("no frames decoded from %s", video_path)
        return

    _rescale(frames)

    # Derive fps from timestamps for accurate metadata.
    if len(frames) > 1:
        total_seconds = (frames[-1].ts_ms - frames[0].ts_ms) / 1000.0
        fps = (len(frames) - 1) / total_seconds if total_seconds > 0 else 30.0
    else:
        fps = 30.0

    clip = _to_clip_json(frames=frames, gloss=gloss, language=language, fps=fps)
    output_path.write_text(json.dumps(clip, separators=(",", ":")), encoding="utf-8")
    log.info("wrote %d frames (%.1f fps) to %s", len(frames), fps, output_path)


def _gloss_from_stem(stem: str) -> str:
    """Turn 'thank-you-v1' or 'thank-you' into 'THANK-YOU'."""
    if "-v" in stem:
        base = stem.rsplit("-v", 1)[0]
    else:
        base = stem
    return base.upper()


def main() -> int:
    args = parse_args()

    if args.input:
        if not args.output:
            log.error("--output is required in single mode")
            return 2
        if not args.gloss:
            log.error("--gloss is required in single mode")
            return 2
        _process_one(
            video_path=Path(args.input),
            output_path=Path(args.output),
            gloss=args.gloss,
            language=args.language,
            args=args,
        )
        return 0

    # Batch mode.
    if not args.output_root:
        log.error("--output-root is required in batch mode")
        return 2
    src_root = Path(args.batch)
    dst_root = Path(args.output_root)
    videos = sorted(src_root.rglob("*.mp4"))
    if not videos:
        log.error("no .mp4 files found under %s", src_root)
        return 1
    log.info("batch mode: %d videos to process", len(videos))
    for video in videos:
        stem = video.stem
        output = dst_root / f"{stem}.json"
        if output.exists() and not args.force:
            log.info("skipping (exists): %s", output)
            continue
        gloss = _gloss_from_stem(stem)
        _process_one(
            video_path=video,
            output_path=output,
            gloss=gloss,
            language=args.language,
            args=args,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
