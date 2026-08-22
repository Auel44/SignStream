# Fine-Tuning Moonshine on AfriSpeech-200

## The three-step recipe

```bash
# One-off: install training deps.
pip install -r requirements.txt

# 1. Download the dataset into data/datasets/afrispeech-200/.
python download_afrispeech.py --subset west-africa       # ~10 GB

# 2. Fine-tune (the GPU step — but Moonshine is small, so it's quick).
python finetune_afrispeech.py \
    --base moonshine/base \
    --dataset ../../../datasets/afrispeech-200 \
    --output ./checkpoint

# 3. Export to the ONNX artefact the asr Lambda loads.
python export_to_onnx.py \
    --input ./checkpoint/final \
    --output ../onnx
```

Then deploy by setting `ASR_MODEL=moonshine-african` and pointing
`ASR_MOONSHINE_MODEL_PATH` at `../onnx` (baked into the asr Lambda's
container image at build time — the Dockerfile lives with the Lambda in
`backend/functions/asr/Dockerfile`).

> **Note:** Moonshine's fine-tune / export entry points come from the
> [upstream repo](https://github.com/usefulsensors/moonshine) and can change
> between releases. If a step errors on a missing function, check the current
> Moonshine training docs and adjust the marked hooks in
> `finetune_afrispeech.py` / `export_to_onnx.py`.

## Where to run step 2 for free

Moonshine is small enough that any free-tier GPU finishes fast:

### 1. Kaggle Notebooks — recommended

- **Free GPU:** P100 or T4 (16 GB), 30 hours/week.
- **Disk:** ~73 GB scratch — fits the West-Africa subset + checkpoints.
- **Setup:** [kaggle.com](https://www.kaggle.com) → New Notebook → Accelerator
  → GPU → upload this `training/` folder as a Dataset.

### 2. Google Colab (free tier)

- **Free GPU:** T4 (16 GB).
- **Disk:** ~78 GB scratch (wiped between sessions); mount Google Drive for
  persistence and save `--output` there so a disconnect is recoverable.
- **Setup:** [colab.research.google.com](https://colab.research.google.com) →
  Runtime → Change runtime type → T4 GPU.

### 3. AWS SageMaker Studio Lab

- **Free GPU:** T4, ~8 hours/day. 15 GB persistent disk — use the Ghana-only
  subset if space is tight.
- **Setup:** apply at [studiolab.sagemaker.aws](https://studiolab.sagemaker.aws).

### 4. Lightning AI Studios

- ~15 free GPU-hours/month, persistent workspaces. [lightning.ai](https://lightning.ai).

### 5. Local PC

- Any NVIDIA GPU with ≥ 6 GB VRAM works for Moonshine (RTX 3050/3060 and up).
  Integrated / AMD / Apple-silicon GPUs: use Kaggle instead.

### Not free but cheap

- **RunPod / Vast.ai** (~$0.15–0.30/hr). A full Moonshine fine-tune costs well
  under $1 in compute because the model is small.

## Expected training time

Moonshine is far smaller than Whisper, so fine-tuning is fast. Rough numbers
on a single T4 with the West-Africa subset (~10 GB, ~30 h audio, 5 epochs):

| Moonshine size | Time | Peak VRAM |
| --- | --- | --- |
| tiny | ~1 hour | 4 GB |
| **base** | **~2 hours** | **6 GB** |

Both finish comfortably inside a single free Kaggle/Colab session.

## Evaluation targets

Aim for these WER numbers on the AfriSpeech-200 *test* split, Ghana subset:

| Model | Target WER | Notes |
| --- | --- | --- |
| Baseline `moonshine/base` (no fine-tune) | ~25–30% | The problem we're fixing. |
| **Fine-tuned `moonshine/base` on West-Africa** | **~13–17%** | Realistic for 5 epochs. |

`finetune_afrispeech.py` prints WER after every epoch and saves the best
checkpoint. Anything below ~17% on the Ghana subset is a strong, publishable
result — and it runs on free CPU at inference time, which is the whole point.

## Publishing the resulting model

Push your fine-tuned checkpoint to HuggingFace so future contributors reuse it:

```bash
huggingface-cli login
huggingface-cli upload <your-username>/signstream-moonshine-base-african \
    ./checkpoint/final .
```
