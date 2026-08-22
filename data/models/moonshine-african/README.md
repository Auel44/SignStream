# Moonshine — African-Accent Fine-Tune

Moonshine fine-tuned on the
[AfriSpeech-200](https://huggingface.co/datasets/intronhealth/afrispeech-200)
dataset (Intron Health) — ~200 hours of African-accented English from 13
countries including **Ghana, Nigeria, Kenya, and South Africa**. This is the
recommended production engine for SignStream in Ghana.

## Why this exists

Baseline Moonshine is trained mostly on North-American / European English. On
Ghanaian or West-African speech — the accents in your users' streaming feeds —
its Word Error Rate rises. Fine-tuning on AfriSpeech-200 recovers most of that
gap while keeping Moonshine's key advantage: **it still runs fast on a Lambda
CPU**, so you get better accent accuracy without moving to a paid GPU.

## Directory layout (after training)

```text
moonshine-african/
├── README.md                      ← this file
├── training/
│   ├── README.md                  ← how to run fine-tuning (+ free GPU guide)
│   ├── requirements.txt
│   ├── download_afrispeech.py     ← pull AfriSpeech-200 from HuggingFace
│   ├── finetune_afrispeech.py     ← fine-tune Moonshine (GPU)
│   └── export_to_onnx.py          ← produce the runtime ONNX artefact
└── onnx/                          ← ← final artefact used by the asr Lambda
    └── (ONNX model files produced by export_to_onnx.py)
```

## Runtime integration

Once `onnx/` holds the fine-tuned model, deploy by setting on the asr Lambda:

```bash
ASR_MODEL=moonshine-african
ASR_MOONSHINE_MODEL_PATH=/opt/model/moonshine-african   # baked into the image
```

The `AfricanMoonshineEngine` in `backend/functions/asr/asr_engine.py` loads
the local ONNX directory — same rolling-window behaviour as the baseline
engine, different weights.

## Training vs. serving cost

- **Fine-tuning** is a one-off that needs a GPU — run it **free** on Colab or
  Kaggle (see `training/README.md`). Training on GPU does not mean serving on
  GPU.
- **Serving** stays on the free-tier Lambda CPU, because Moonshine is light
  enough to run there. This is the whole reason Moonshine was chosen over
  Parakeet.

## Licensing

- Moonshine base weights + code: **MIT**.
- AfriSpeech-200 dataset: Creative Commons (check the current card).
- Your fine-tuned checkpoint: keep MIT / CC-BY-SA to stay open. Recommended:
  publish it on HuggingFace so future contributors reuse it.

## Next steps

See [`training/README.md`](training/README.md) for the exact commands and the
free-GPU options (Colab / Kaggle / SageMaker Studio Lab).
