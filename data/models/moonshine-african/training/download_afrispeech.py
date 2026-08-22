"""Download AfriSpeech-200 (accent-configured) into a train/validation/test
layout of manifests + 16 kHz wavs that finetune_afrispeech.py can read.

Usage
-----
    python download_afrispeech.py --subset ghana --out /content/afrispeech-200
    python download_afrispeech.py --subset west-africa --out /content/afrispeech-200

Key facts about AfriSpeech-200
------------------------------
* It is African-accented **English** speech (perfect for SignStream, which
  transcribes English audio).
* It is a **script-based** dataset, so `datasets` must be < 3.0 and
  `trust_remote_code=True` is required.
* It is organised into **configs by accent** (the speaker's native language),
  not a single flat dataset. Ghanaian-accented English lives in the `twi`,
  `akan`, and `akan-fante` configs. Each row also carries `country` ('GH',
  'NG', …) and `accent`.

What this script writes
-----------------------
    <out>/train/manifest.tsv        (audio_path <tab> transcript <tab> accent <tab> country)
    <out>/train/audio/*.wav         (16 kHz mono)
    <out>/validation/…              (carved from train if the config has no dev split)
    <out>/test/…
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

log = logging.getLogger("afrispeech-download")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

DATASET_REPO = "intronhealth/afrispeech-200"

# Subsets are lists of accent CONFIGS (not country filters).
SUBSETS = {
    # Ghana only — the most relevant accents for a Ghana-focused fine-tune.
    "ghana": ["twi", "akan", "akan-fante"],
    # Ghana + the major Nigerian accents = broad West-African English.
    "west-africa": ["twi", "akan", "akan-fante", "yoruba", "hausa", "igbo", "pidgin"],
    # The full corpus (large — tens of GB).
    "all": ["all"],
}

# AfriSpeech split names → our folder names.
SPLIT_MAP = {
    "train": "train",
    "dev": "validation",
    "validation": "validation",
    "test": "test",
}

TARGET_SR = 16000


def resolve_out(user_path: str | None) -> Path:
    """Default to `<repo>/data/datasets/afrispeech-200/`."""
    if user_path:
        return Path(user_path).expanduser().resolve()
    here = Path(__file__).resolve()
    if len(here.parents) < 5:
        raise SystemExit(
            "No --out provided and the repo layout was not found. "
            "Pass --out /path/to/afrispeech-200 explicitly."
        )
    return here.parents[4] / "data" / "datasets" / "afrispeech-200"


def _clean(text: str) -> str:
    return (text or "").strip().replace("\t", " ").replace("\n", " ").replace("\r", " ")


def _write_config(config: str, out_dir: Path, headers: set[str], token: str | None) -> dict[str, int]:
    """Load one accent config and append its rows to the split manifests."""
    from datasets import load_dataset  # type: ignore[import-not-found]
    import numpy as np  # type: ignore[import-not-found]
    import soundfile as sf  # type: ignore[import-not-found]

    log.info("loading config %r", config)
    dsd = load_dataset(
        DATASET_REPO,
        config,
        cache_dir=str(out_dir / "_cache"),
        token=token,
        trust_remote_code=True,
    )

    counts: dict[str, int] = {}
    for split_name, split in dsd.items():
        target = SPLIT_MAP.get(split_name, split_name)
        split_dir = out_dir / target
        audio_dir = split_dir / "audio"
        audio_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = split_dir / "manifest.tsv"

        with manifest_path.open("a", encoding="utf-8") as manifest:
            if target not in headers:
                manifest.write("audio_path\ttranscript\taccent\tcountry\n")
                headers.add(target)

            for row in split:
                text = _clean(row.get("transcript", ""))
                if not text:
                    continue
                audio = row["audio"]
                arr = np.asarray(audio["array"], dtype="float32")
                sr = int(audio["sampling_rate"])
                if sr != TARGET_SR:
                    import librosa  # type: ignore[import-not-found]
                    arr = librosa.resample(arr, orig_sr=sr, target_sr=TARGET_SR)

                aid = row.get("audio_id") or row.get("path") or f"{config}-{counts.get(target, 0)}"
                safe = str(aid).replace("/", "_").replace("\\", "_")
                wav_path = audio_dir / f"{config}-{safe}.wav"
                sf.write(str(wav_path), arr, TARGET_SR)

                manifest.write(
                    f"{wav_path}\t{text}\t{row.get('accent', '')}\t{row.get('country', '')}\n"
                )
                counts[target] = counts.get(target, 0) + 1

        log.info("  %s: %d rows so far", target, counts.get(target, 0))
    return counts


def _carve_validation(out_dir: Path, fraction: float = 0.1) -> None:
    """If no validation split exists, move a fraction of train into validation."""
    train_manifest = out_dir / "train" / "manifest.tsv"
    val_manifest = out_dir / "validation" / "manifest.tsv"
    if val_manifest.exists() or not train_manifest.exists():
        return

    lines = train_manifest.read_text(encoding="utf-8").splitlines()
    if len(lines) <= 1:
        return
    header, rows = lines[0], lines[1:]
    n_val = max(1, int(len(rows) * fraction))
    val_rows, keep_rows = rows[:n_val], rows[n_val:]

    (out_dir / "validation").mkdir(parents=True, exist_ok=True)
    val_manifest.write_text("\n".join([header, *val_rows]) + "\n", encoding="utf-8")
    train_manifest.write_text("\n".join([header, *keep_rows]) + "\n", encoding="utf-8")
    log.info("carved %d rows from train into validation (no dev split in dataset)", n_val)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--subset", choices=list(SUBSETS.keys()), default="ghana",
                   help="Accent-config group to fetch. Default: ghana (twi/akan/akan-fante).")
    p.add_argument("--out", default=None,
                   help="Destination directory. Defaults to data/datasets/afrispeech-200/.")
    p.add_argument("--hf-token", default=None,
                   help="HuggingFace token. Prefer `huggingface-cli login` instead.")
    args = p.parse_args()

    out_dir = resolve_out(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    log.info("output directory: %s", out_dir)

    try:
        import datasets  # noqa: F401  # type: ignore[import-not-found]
        import numpy  # noqa: F401  # type: ignore[import-not-found]
        import soundfile  # noqa: F401  # type: ignore[import-not-found]
    except ImportError as exc:
        log.error("missing dependency: %s. Run: pip install -r requirements.txt "
                  "(and remember: datasets must be < 3.0)", exc)
        return 1

    configs = SUBSETS[args.subset]
    log.info("subset=%s → configs=%s", args.subset, configs)

    headers: set[str] = set()
    totals: dict[str, int] = {}
    for config in configs:
        try:
            counts = _write_config(config, out_dir, headers, args.hf_token)
        except Exception as exc:  # noqa: BLE001
            log.error("config %r failed (%s) — continuing with the rest", config, exc)
            continue
        for k, v in counts.items():
            totals[k] = totals.get(k, 0) + v

    _carve_validation(out_dir)

    log.info("done. rows per split: %s", totals)
    if not totals:
        log.error("no rows written — check the config names and your connection.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
