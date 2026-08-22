"""Export a fine-tuned Moonshine checkpoint to ONNX.

The asr Lambda loads Moonshine via ONNX Runtime (`useful-moonshine-onnx`),
so the fine-tuned checkpoint has to be exported to ONNX before deployment.

Usage
-----
    python export_to_onnx.py \
        --input ./checkpoint/final \
        --output ../onnx

`../onnx` is the directory the asr Lambda's `AfricanMoonshineEngine` reads
via the `ASR_MOONSHINE_MODEL_PATH` env var.

Honest note
-----------
Moonshine's export path comes from the upstream repo and may change between
releases. If the `moonshine.export_onnx` entry point below has moved, follow
the current Moonshine repo instructions for ONNX export and point the asr
Lambda at whatever directory the exported .onnx files land in.
"""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
from pathlib import Path

log = logging.getLogger("moonshine-onnx-export")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", required=True,
                   help="Path to the fine-tuned Moonshine checkpoint directory.")
    p.add_argument("--output", default="../onnx",
                   help="Where the ONNX artefact should be written.")
    args = p.parse_args()

    input_dir = Path(args.input).resolve()
    output_dir = Path(args.output).resolve()

    if not input_dir.exists():
        log.error("input checkpoint not found: %s", input_dir)
        return 1

    if output_dir.exists():
        log.warning("removing existing %s", output_dir)
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        import moonshine  # type: ignore[import-not-found]
    except ImportError:
        log.error(
            "The `useful-moonshine` package is not installed. Install it from "
            "the Moonshine repo, then re-run."
        )
        return 1

    log.info("exporting %s -> %s (ONNX)", input_dir, output_dir)
    # NOTE: adjust to the current Moonshine export API if it has moved.
    moonshine.export_onnx(str(input_dir), str(output_dir))  # type: ignore[attr-defined]

    log.info("wrote ONNX artefact to %s", output_dir)
    log.info(
        "\nDeploy by setting:\n"
        "    ASR_MODEL=moonshine-african\n"
        "    ASR_MOONSHINE_MODEL_PATH=%s\n"
        "in the asr Lambda's environment (Terraform: async stack), and\n"
        "COPY this directory into the asr Docker image.",
        output_dir,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
