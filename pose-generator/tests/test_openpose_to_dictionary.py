"""Unit tests for the OpenPose → dictionary converter core functions."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import openpose_to_dictionary as conv  # noqa: E402


def _frame(neck=(100.0, 100.0, 0.9), r_sh=(80.0, 110.0, 0.9), l_sh=(120.0, 110.0, 0.9),
           r_wrist=(80.0, 200.0, 0.9)):
    """Build a minimal BODY_25 + empty hands OpenPose person dict."""
    pose = [0.0] * (25 * 3)

    def put(idx, xyc):
        pose[idx * 3], pose[idx * 3 + 1], pose[idx * 3 + 2] = xyc

    put(conv.NECK, neck)
    put(conv.R_SHOULDER, r_sh)
    put(conv.L_SHOULDER, l_sh)
    put(4, r_wrist)  # right wrist
    return {
        "pose_keypoints_2d": pose,
        "hand_left_keypoints_2d": [0.0] * (21 * 3),
        "hand_right_keypoints_2d": [0.0] * (21 * 3),
    }


def test_frame_points_pads_to_67() -> None:
    pts = conv._frame_points({})
    assert len(pts) == 67  # 25 pose + 21 + 21 hands


def test_joint_names_count() -> None:
    assert len(conv.JOINT_NAMES) == 67
    assert conv.JOINT_NAMES[conv.NECK] == "neck"
    assert conv.JOINT_NAMES[25] == "l_hand_0"
    assert conv.JOINT_NAMES[46] == "r_hand_0"


def test_reference_and_normalise_center_neck_at_origin() -> None:
    frames = [conv._frame_points(_frame())]
    origin, scale = conv._reference(frames)
    assert origin == (100.0, 100.0)  # neck position
    # shoulder width = |120-80| = 40 px → scale = 0.40/40 = 0.01
    assert abs(scale - 0.01) < 1e-9

    norm = conv._normalise(frames, origin, scale)
    neck = norm[0][conv.NECK]
    assert neck == [0.0, 0.0, 0.0]  # neck maps to origin


def test_normalise_flips_y_axis() -> None:
    # Wrist is BELOW the neck in image space (larger y). After flipping to
    # Y-up it should come out NEGATIVE.
    frames = [conv._frame_points(_frame(r_wrist=(80.0, 200.0, 0.9)))]
    origin, scale = conv._reference(frames)
    norm = conv._normalise(frames, origin, scale)
    wrist_y = norm[0][4][1]
    assert wrist_y < 0


def test_low_confidence_points_become_zero() -> None:
    frames = [conv._frame_points(_frame(r_wrist=(80.0, 200.0, 0.0)))]  # conf 0
    origin, scale = conv._reference(frames)
    norm = conv._normalise(frames, origin, scale)
    assert norm[0][4] == [0.0, 0.0, 0.0]


def test_convert_folder_writes_valid_clip(tmp_path: Path) -> None:
    # Build a tiny 3-frame word folder.
    word_dir = tmp_path / "HELLO"
    word_dir.mkdir()
    for i in range(3):
        payload = {"version": 1.3, "people": [_frame(r_wrist=(80.0, 200.0 - i * 30, 0.9))]}
        (word_dir / f"HELLO_{i:012d}_keypoints.json").write_text(json.dumps(payload))

    out_root = tmp_path / "ghsl"
    ok = conv.convert_folder(word_dir, out_root, "GhSL", "v1", fps=25.0, force=True)
    assert ok

    clip = json.loads((out_root / "hello-v1.json").read_text())
    assert clip["signId"] == "ghsl-hello-v1"
    assert clip["gloss"] == "HELLO"
    assert clip["language"] == "GhSL"
    assert clip["source"] == "openpose-2d"
    assert len(clip["joints"]) == 67
    assert len(clip["frames"]) == 3
    assert clip["frames"][0]["t"] == 0
    assert len(clip["frames"][0]["positions"]) == 67


def test_slug() -> None:
    assert conv._slug("ABSTAIN_OR_AVOID") == "abstain-or-avoid"
    assert conv._slug("ACCRA_2") == "accra-2"
    assert conv._slug("ACT_OR_ACTION") == "act-or-action"
