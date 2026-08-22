"""Unit tests for the WLASL-specific parts of the ASL dictionary build.

The OpenPose maths is covered by test_openpose_to_dictionary.py; what is
WLASL-specific — and what actually went wrong when building the dictionary —
is instance *selection*: resolving the frame range and rejecting recordings
where OpenPose never found the hands.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import wlasl_to_dictionary as wl  # noqa: E402


def _person(hand_conf: float, wrist_conf: float = 0.9, torso_conf: float = 0.9) -> dict:
    pose = [0.0] * (25 * 3)

    def put(idx: int, conf: float) -> None:
        pose[idx * 3], pose[idx * 3 + 1], pose[idx * 3 + 2] = 100.0, 100.0, conf

    put(wl.NECK, torso_conf)
    put(wl.R_SHOULDER, torso_conf)
    put(wl.L_SHOULDER, torso_conf)
    put(wl.R_WRIST, wrist_conf)
    put(wl.L_WRIST, wrist_conf)

    hand = [100.0, 100.0, hand_conf] * 21
    return {
        "pose_keypoints_2d": pose,
        "hand_left_keypoints_2d": hand,
        "hand_right_keypoints_2d": hand,
    }


def _folder(tmp_path: Path, name: str, n_frames: int, **kwargs) -> Path:
    d = tmp_path / name
    d.mkdir()
    for i in range(1, n_frames + 1):
        payload = {"version": 1.3, "people": [_person(**kwargs)]}
        (d / f"image_{i:05d}_keypoints.json").write_text(json.dumps(payload))
    return d


# ── frame range resolution ───────────────────────────────────────────────────


def test_range_none_when_metadata_has_no_end() -> None:
    assert wl.resolve_range({"frame_start": 1, "frame_end": -1}, 60) is None


def test_range_none_when_folder_already_trimmed() -> None:
    """frame_start in the thousands but the folder holds exactly that many
    frames means the pose extraction already cut the clip — take everything."""
    assert wl.resolve_range({"frame_start": 2150, "frame_end": 2249}, 100) is None


def test_range_applied_when_folder_holds_a_longer_recording() -> None:
    assert wl.resolve_range({"frame_start": 1, "frame_end": 60}, 124) == (1, 60)


def test_range_ignored_when_it_exceeds_what_is_on_disk() -> None:
    """The range indexes a source video we don't have — don't slice to nothing."""
    assert wl.resolve_range({"frame_start": 500, "frame_end": 900}, 80) is None


# ── quality scoring ──────────────────────────────────────────────────────────


def test_score_high_when_hands_are_tracked(tmp_path: Path) -> None:
    folder = _folder(tmp_path, "good", 30, hand_conf=0.9)
    assert wl.score_folder(folder) > 0.9


def test_score_low_when_hands_are_missing(tmp_path: Path) -> None:
    """The failure mode this scorer exists to catch: arms move, fingers never
    do. Such a clip is worse than useless because the handshape IS the word."""
    folder = _folder(tmp_path, "nohands", 30, hand_conf=0.0)
    score = wl.score_folder(folder)
    assert score < 0.45
    assert score < wl.score_folder(_folder(tmp_path, "good", 30, hand_conf=0.9))


def test_score_zero_without_torso(tmp_path: Path) -> None:
    """No confident neck/shoulders means the clip cannot be normalised at all."""
    folder = _folder(tmp_path, "notorso", 30, hand_conf=0.9, torso_conf=0.0)
    assert wl.score_folder(folder) == 0.0


def test_score_zero_for_truncated_recording(tmp_path: Path) -> None:
    folder = _folder(tmp_path, "short", wl.MIN_FRAMES - 1, hand_conf=0.9)
    assert wl.score_folder(folder) == 0.0


def test_score_respects_frame_range(tmp_path: Path) -> None:
    """A range that leaves too few frames is scored as unusable."""
    folder = _folder(tmp_path, "ranged", 40, hand_conf=0.9)
    assert wl.score_folder(folder, (1, 3)) == 0.0
    assert wl.score_folder(folder, (1, 40)) > 0.9
