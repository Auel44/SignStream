# MediaPipe Holistic — Pose Extraction

MediaPipe Holistic detects **543 landmarks per frame** in a single pass:
33 body pose + 21 left hand + 21 right hand + 468 face-mesh points.
That is exactly what the SignStream avatar needs to reproduce a sign.

**In SignStream this model runs OFFLINE, not in Lambda.** It is the core
of `pose-generator/src/extract_keypoints.py`, which turns a recorded
video of a signer into a `dictionary/<lang>/<gloss>-v1.json` clip that
the browser extension replays through Three.js.

## Installed version

- Package: `mediapipe==0.10.35` (or newer — pin in `pose-generator/requirements.txt`)
- Model file: bundled inside the pip package. Nothing to download.
- License: Apache-2.0.

## Verification

```python
import mediapipe as mp

holistic = mp.solutions.holistic.Holistic(
    static_image_mode=False,
    model_complexity=1,
    smooth_landmarks=True,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5,
)
print("MediaPipe Holistic ready")
```

## Where it is used

| Consumer | Purpose |
| --- | --- |
| `pose-generator/src/extract_keypoints.py` | Convert recorded sign videos into pose keypoint JSON clips (the dictionary content). |

Not used in any Lambda. The `asr` and `text-to-gloss` Lambdas do not
touch it. The extension plays the keypoints in Three.js but does not run
MediaPipe itself.

## Model complexity trade-off

| `model_complexity` | Speed (CPU) | Landmark accuracy |
| --- | --- | --- |
| 0 | Fastest | Lowest — misses fingers in fast motion |
| 1 (default) | Moderate | Good for sign language |
| 2 | Slowest | Highest — recommended for dictionary content since offline |

Use `model_complexity=2` for dictionary capture; `0` or `1` when you
just want to preview extraction results on a laptop.

## Coordinate convention MediaPipe returns

- x, y ∈ [0, 1] normalised to the image width/height
- z estimated depth (relative), smaller = closer to the camera
- `visibility ∈ [0, 1]` — usable for filtering out low-confidence points

`pose-generator/src/extract_keypoints.py` remaps these to the
body-relative frame the dictionary schema uses (origin at hip midpoint,
Y-up, metres).
