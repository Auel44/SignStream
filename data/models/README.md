# Model Registry — SignStream

Every pretrained or fine-tuned model that SignStream depends on. Only two
model families are used at runtime: **MediaPipe Holistic** (offline pose
extraction) and **Moonshine** (online speech recognition, ideally
fine-tuned on African-accented speech).

## Active models

| Model | Directory | Role | Runs where |
| --- | --- | --- | --- |
| MediaPipe Holistic | [`mediapipe/`](mediapipe/) | Extract 543-point body/hand/face landmarks from recorded sign videos. Produces the JSON clips in `../../dictionary/`. | Offline (pose-generator on your dev machine) |
| Moonshine (baseline) | [`moonshine/`](moonshine/) | Fast CPU streaming ASR — the dev/production default in the `asr` Lambda. MIT-licensed. Not tuned for African accents. | Online (asr Lambda, container image) |
| **Moonshine fine-tuned on AfriSpeech-200** | [`moonshine-african/`](moonshine-african/) | **Recommended production ASR for Ghana.** Same fast CPU engine, fine-tuned on ~200 h of West/East African English (Ghana, Nigeria, Kenya, more). | Online (asr Lambda) |
| Meta MMS (placeholder) | [`mms/`](mms/) | Future work: transcribe non-English audio in local Ghanaian languages (Twi, Ewe, Ga, Dagbani). ~1B params — hosted on ECS/Fargate rather than Lambda. | Online (future) |

## Why Moonshine, not Whisper

Whisper pads every input to 30 s and re-transcribes the window, which is slow
on a Lambda CPU. Moonshine processes only the audio it is given, so it runs
several times faster on CPU with comparable small-model accuracy — the right
fit for a free-tier, CPU-only deployment. Whisper was removed from the project.

## Removed models

No longer used (earlier / different scope):

- `whisper/`, `whisper-african/` — replaced by Moonshine (faster on CPU).
- `kokoro/` — TTS. SignStream produces avatars, not speech.
- `opus-mt/`, `opus-mt-raw/` — spoken-language translation. Not needed.
- `sign-recognition/` — sign → text. SignStream is one-way audio → sign only.

## Directory structure

```text
data/models/
├── README.md                    ← this file
├── mediapipe/                   ← pretrained, shipped in the mediapipe pip pkg
│   └── README.md
├── moonshine/                   ← Moonshine ONNX baseline (fetched on build)
│   └── README.md
├── moonshine-african/           ← fine-tuned checkpoint + training scripts
│   ├── README.md
│   ├── training/
│   │   ├── README.md            ← how to run fine-tuning (+ free GPU guide)
│   │   ├── requirements.txt
│   │   ├── download_afrispeech.py
│   │   ├── finetune_afrispeech.py
│   │   └── export_to_onnx.py
│   └── onnx/                    ← ONNX artefact lands here after training
└── mms/                         ← placeholder for future MMS integration
    └── README.md
```

## How the models fit together

**Offline (once, when you populate `dictionary/`):**

```text
recorded sign video (mp4)
        │
        ▼
   MediaPipe Holistic  ── pose-generator/src/extract_keypoints.py
        │
        ▼
   dictionary/<lang>/<gloss-slug>-v1.json   ← 543 landmarks/frame
        │
        ▼
   uploaded to S3 → served through CloudFront to the extension
```

**Online (every user session):**

```text
streaming media audio (from the browser tab)
        │
        ▼
   asr Lambda  ── uses ONE of:
        │             stub               (dev)
        │             moonshine          (baseline; moonshine/)
        │             moonshine-african  (production; moonshine-african/)
        │             mms                (future, Twi/Ewe/etc.)
        ▼
   transcript → text-to-gloss Lambda → sign IDs
                                       │
                                       ▼
   extension fetches dictionary/<lang>/<sign-id>.json from CloudFront
                                       │
                                       ▼
                          Three.js avatar replays the keypoints
```

## First-time setup

```bash
# 1. Baseline Moonshine (fetched by the ONNX package on first use / build)
python -c "
import numpy as np, moonshine_onnx
moonshine_onnx.transcribe(np.zeros(16000, dtype='float32'), 'moonshine/base')
print('Baseline Moonshine ready.')
"

# 2. African-accent fine-tune — see data/models/moonshine-african/training/README.md
#    Needs a GPU (free on Colab/Kaggle). Training on GPU does NOT mean serving
#    on GPU — the fine-tuned model still runs on the free-tier Lambda CPU.

# 3. MediaPipe (bundled with the pip package — nothing to download)
python -c "import mediapipe; print(mediapipe.__version__)"
```

## Git-ignored contents

`data/models/*` is in `.gitignore` — model files are never committed to git
(they're easy to re-download). Use DVC or a shared S3 bucket to distribute
fine-tuned checkpoints across your team.
