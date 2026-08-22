# pose-generator — Build Dictionary Clips

Produces the JSON keypoint clips the browser extension's Three.js avatar
replays. There are **two ways in**, depending on what you start with:

1. **You have keypoints already** (e.g. the GSL_openpose_data dataset — one
   folder per sign, OpenPose frames inside) → use `openpose_to_dictionary.py`.
   No MediaPipe, no video decoding — just converts the existing points.
2. **You have raw video** (one sign per clip, named by word) → use
   `extract_keypoints.py`, which runs MediaPipe Holistic on the video.

Both run **offline on your dev machine** and write
`dictionary/<lang>/<slug>-v1.json` files that get uploaded to S3 and served
through CloudFront to every extension user.

## Converting the GSL OpenPose dataset (the fast path)

The `GSL_openpose_data` dataset has ~1200 folders, one per Ghanaian sign, each
holding the sign's video plus one OpenPose `*_keypoints.json` per frame. The
folder name IS the word. Convert them all in one command:

```bash
python src/openpose_to_dictionary.py \
    --batch "data/datasets/general/GSL_openpose_data" \
    --output-root dictionary/ghsl \
    --language GhSL
```

Each folder → one `dictionary/ghsl/<slug>-v1.json` clip (all frames of the
sign, in order, normalised to a body-relative frame). Test on a few first with
`--limit 5`; overwrite existing clips with `--force`.

OpenPose input per frame: 25 body + 21 left-hand + 21 right-hand 2D points.
Output: the same 67 joints, coordinates re-centred on the neck, Y-up, scaled so
shoulder width ≈ 0.4 m, z = 0 (source is 2D).

## The pipeline in one picture

```text
data/datasets/sign-videos/ghsl/hello-v1.mp4
                    │
                    ▼
   src/extract_keypoints.py
       │
       ├─ decode video (OpenCV)
       ├─ per-frame MediaPipe Holistic
       ├─ pick 33 body + 21 left-hand + 21 right-hand landmarks
       ├─ resample to a fixed body-relative frame (origin at hips, metres)
       └─ serialise to the dictionary schema
                    │
                    ▼
   dictionary/ghsl/hello-v1.json
```

## Files

| File | Job |
| --- | --- |
| `src/openpose_to_dictionary.py` | Convert existing OpenPose keypoint folders → dictionary clips (single or `--batch`). No MediaPipe needed. |
| `src/extract_keypoints.py` | Run MediaPipe Holistic on raw video → dictionary clip (single or `--batch`). |
| `src/__init__.py` | Package marker. |
| `tests/` | Unit tests for the OpenPose converter. |
| `requirements.txt` | opencv-python, mediapipe, numpy (only needed for the video path). |
| `README.md` | This file. |

## Setup

```bash
cd pose-generator
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Usage — single clip

```bash
python src/extract_keypoints.py \
    --input ../data/datasets/sign-videos/ghsl/hello-v1.mp4 \
    --output ../dictionary/ghsl/hello-v1.json \
    --gloss HELLO \
    --language GhSL
```

## Usage — batch a whole language folder

```bash
python src/extract_keypoints.py \
    --batch ../data/datasets/sign-videos/ghsl \
    --output-root ../dictionary/ghsl \
    --language GhSL
```

Batch mode:
- Walks the input folder
- For each `<gloss-slug>-v<n>.mp4`, produces `<gloss-slug>-v<n>.json`
  under `--output-root`
- Skips files whose output already exists (safe to re-run)

## Which MediaPipe complexity to use

```
--complexity 0    fastest, misses fingers in fast motion (avoid)
--complexity 1    good balance (default)
--complexity 2    slowest, best fidelity — recommended for real dictionary content
```

For real dictionary content, use `--complexity 2` on a machine with a
decent CPU. Extraction is ~2× real-time at complexity 2, so a 2-second
clip takes ~4 seconds.

## Coordinate convention in the output

- Origin: midpoint of the two hip landmarks in the first frame.
- X: right (in the signer's frame — mirror-image of the camera).
- Y: up.
- Z: forward, into the camera.
- Units: metres (roughly — MediaPipe returns normalised coordinates and
  we rescale so the shoulder width is ~40 cm).

This matches the dictionary schema documented in
`../dictionary/README.md`.

## What the extension does with the output

The extension's Three.js avatar reads the JSON, animates each named
joint (`left_wrist`, `right_elbow`, etc.) between successive frames using
`requestAnimationFrame`, and interpolates between keyframes for smooth
playback. Signs with more frames animate more finely.

## Verifying an extraction

Play the resulting JSON in the extension's development harness (or use a
quick script that renders the keypoints into a matplotlib animation).
Look for:

- Head stays roughly still throughout.
- Wrists trace smooth arcs — no jitter or "jumps" that suggest tracking loss.
- Hand landmarks (last 21+21 joints) are populated, not zeros — those
  are the difference between a recognisable sign and a shrug.

If a clip fails those checks, re-record with better lighting or use
`--complexity 2`.
