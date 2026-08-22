"""Fine-tune Moonshine on AfriSpeech-200.

⚠️  NOT RUNNABLE AS-IS — READ THIS FIRST  ⚠️
--------------------------------------------
The public `useful-moonshine` package ships Moonshine for INFERENCE ONLY.
`moonshine.load_model()` returns a Keras inference wrapper that has NO
`train_step` / `fit` method, so the training loop below will raise
`AttributeError: 'Moonshine' object has no attribute 'train_step'`.

Fine-tuning Moonshine is therefore a genuine engineering task, not a script
tweak: you must reach into Moonshine's internal Keras model (preprocessor →
encoder → decoder), wire up its tokenizer, build a teacher-forcing training
loop with a token-level loss, and `keras.Model.fit()` it. That depends on
Moonshine internals that change between releases and is out of scope here.

RECOMMENDED PATH: deploy the BASE model instead — set `asr_model = "moonshine"`
in the Terraform. It needs no training and runs on the free-tier Lambda CPU.
The corpus that `download_afrispeech.py` builds stays ready for whenever a
proper Moonshine (or alternative) fine-tuning harness is built. See
`../README.md` and `data/models/README.md`.

The data-loading / WER-evaluation helpers below are correct and reusable; only
the model training call (`model.train_step`) is a placeholder that the real
Moonshine training harness must replace.

Usage (once a real training harness exists)
-------------------------------------------
    python finetune_afrispeech.py \
        --base moonshine/base \
        --dataset ../../../datasets/afrispeech-200 \
        --output ./checkpoint

GPU requirements (Moonshine is small — far lighter than Whisper)
----------------------------------------------------------------
    | Moonshine size | Min GPU VRAM |
    | tiny           | 4 GB         |
    | base           | 6 GB         |

Both fit any free-tier GPU (Kaggle P100/T4, Colab T4) with room to spare.

Output
------
The best checkpoint is written to `--output/final/`. Run `export_to_onnx.py`
afterwards to produce the ONNX artefact the asr Lambda loads.
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("finetune-afrispeech")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--base", default="moonshine/base",
                   choices=["moonshine/tiny", "moonshine/base"],
                   help="Base Moonshine preset to fine-tune.")
    p.add_argument("--dataset", default=None,
                   help="Path to the AfriSpeech-200 root (with train/, validation/, "
                        "test/). Defaults to data/datasets/afrispeech-200/ relative to "
                        "the repo when the script lives inside it.")
    p.add_argument("--output", default="./checkpoint",
                   help="Where to save the fine-tuned checkpoint.")
    p.add_argument("--batch-size", type=int, default=16)
    p.add_argument("--epochs", type=int, default=5)
    p.add_argument("--lr", type=float, default=1e-4)
    return p.parse_args()


def resolve_dataset_dir(user_path: str | None) -> Path:
    """Where the AfriSpeech-200 dataset lives.

    Prefer the explicit --dataset argument. Otherwise fall back to
    data/datasets/afrispeech-200/ relative to the repo root — but only when
    the script actually lives inside the repo tree (it won't on Colab/Kaggle,
    where the scripts are uploaded on their own, so we guard the parents[]
    lookup to avoid an IndexError).
    """
    if user_path:
        return Path(user_path).expanduser().resolve()
    here = Path(__file__).resolve()
    if len(here.parents) >= 5:
        return here.parents[4] / "data" / "datasets" / "afrispeech-200"
    # Script uploaded outside the repo (e.g. Colab) with no --dataset given.
    raise SystemExit(
        "No --dataset provided and the repo layout was not found. "
        "Pass --dataset /path/to/afrispeech-200 explicitly."
    )


@dataclass
class AudioTextExample:
    audio_path: str
    transcript: str


def load_manifest(split_dir: Path) -> list[AudioTextExample]:
    manifest = split_dir / "manifest.tsv"
    if not manifest.exists():
        raise FileNotFoundError(f"missing manifest: {manifest}")
    rows: list[AudioTextExample] = []
    with manifest.open("r", encoding="utf-8") as f:
        header = f.readline().strip().split("\t")
        assert header[:2] == ["audio_path", "transcript"], header
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            audio_path, transcript = parts[0], parts[1]
            if audio_path and transcript:
                rows.append(AudioTextExample(audio_path=audio_path, transcript=transcript))
    log.info("loaded %d rows from %s", len(rows), manifest)
    return rows


def _load_audio(path: str):
    import numpy as np  # type: ignore[import-not-found]
    import soundfile as sf  # type: ignore[import-not-found]

    audio, sr = sf.read(path)
    if sr != 16000:
        import librosa  # type: ignore[import-not-found]
        audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
    return np.asarray(audio, dtype="float32")


def main() -> int:
    args = parse_args()

    # Dependencies are imported lazily so `-h` works without them installed.
    try:
        import torch  # type: ignore[import-not-found]  # noqa: F401
        import evaluate  # type: ignore[import-not-found]
    except ImportError as exc:
        log.error("missing dependency: %s. Run: pip install -r requirements.txt", exc)
        return 1

    try:
        import moonshine  # type: ignore[import-not-found]
    except ImportError:
        log.error(
            "The `useful-moonshine` training package is not installed. Install "
            "it from the Moonshine repo per requirements.txt, then re-run."
        )
        return 1

    dataset_root = resolve_dataset_dir(args.dataset)
    train_rows = load_manifest(dataset_root / "train")
    eval_rows = load_manifest(dataset_root / "validation")
    log.info("train=%d eval=%d", len(train_rows), len(eval_rows))

    # ── Model ────────────────────────────────────────────────────────────────
    # NOTE: adjust to the current Moonshine fine-tuning entry point. As of
    # writing, the model is loaded from the preset and fine-tuned by continuing
    # training on (audio, text) pairs. The wrapper below isolates that call so
    # only this block changes if the upstream API moves.
    log.info("loading base model: %s", args.base)
    model = moonshine.load_model(args.base)  # type: ignore[attr-defined]
    metric = evaluate.load("wer")

    output_dir = Path(args.output).resolve()
    (output_dir / "final").mkdir(parents=True, exist_ok=True)

    best_wer = float("inf")
    for epoch in range(args.epochs):
        log.info("── epoch %d/%d ──", epoch + 1, args.epochs)
        # Training loop (delegates to the Moonshine model's own train step).
        for i in range(0, len(train_rows), args.batch_size):
            batch = train_rows[i : i + args.batch_size]
            audios = [_load_audio(r.audio_path) for r in batch]
            texts = [r.transcript for r in batch]
            model.train_step(audios, texts, lr=args.lr)  # type: ignore[attr-defined]

        # Evaluation.
        preds, refs = [], []
        for r in eval_rows:
            preds.append(model.transcribe(_load_audio(r.audio_path)))  # type: ignore[attr-defined]
            refs.append(r.transcript)
        wer = 100.0 * metric.compute(predictions=preds, references=refs)
        log.info("epoch %d WER=%.2f%%", epoch + 1, wer)

        if wer < best_wer:
            best_wer = wer
            model.save(str(output_dir / "final"))  # type: ignore[attr-defined]
            log.info("new best (%.2f%%) saved to %s", wer, output_dir / "final")

    log.info("done. best WER=%.2f%%  checkpoint=%s", best_wer, output_dir / "final")
    log.info("Next: run export_to_onnx.py to produce the runtime artefact.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
