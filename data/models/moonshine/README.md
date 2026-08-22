# Moonshine — Baseline Streaming ASR (CPU)

[Moonshine](https://github.com/usefulsensors/moonshine) by Useful Sensors is
a fast, low-latency speech-recognition model **built for CPU / edge**. It is
the runtime ASR engine for SignStream's `asr` Lambda.

**License:** MIT (both code and weights) — fully free and open.

## Why Moonshine and not Whisper

Whisper pads every input to 30 seconds and re-transcribes the whole window,
which is slow on a Lambda CPU. Moonshine processes **only the audio it is
given**, so transcribing SignStream's short rolling buffer is much cheaper —
several times faster than Whisper-tiny/base on the same CPU, with comparable
accuracy at the small-model tier. That is exactly the property the free-tier,
Lambda-CPU deployment needs.

## Variants

| Preset | Params | Speed (CPU) | Accuracy |
| --- | --- | --- | --- |
| `moonshine/tiny` | ~27 M | Fastest | Good |
| `moonshine/base` | ~62 M | Fast | Better (default) |

Selected via the `ASR_MOONSHINE_MODEL` env var on the asr Lambda.

## Runtime — the ONNX build

SignStream uses `useful-moonshine-onnx` (ONNX Runtime, no PyTorch) rather
than the Torch build:

- much smaller container image (no multi-GB torch/CUDA stack),
- good CPU throughput,
- fits comfortably in a Lambda container.

The model weights download on first import; the asr `Dockerfile`
pre-downloads the default preset at build time so the first cold start does
not pay the fetch cost.

## Directory contents

Empty by default — the ONNX weights are fetched by the `moonshine_onnx`
package at build/first-run and cached inside the container image. Nothing is
committed to git.

## Verification

```python
import numpy as np
import moonshine_onnx

# One second of silence just to exercise the model load + transcribe path.
text = moonshine_onnx.transcribe(np.zeros(16000, dtype="float32"), "moonshine/base")
print("Moonshine ready:", text)
```

## How the asr Lambda uses it

`backend/functions/asr/asr_engine.py` → `MoonshineEngine`:

1. Accumulate incoming 250 ms PCM frames into a rolling ~4 s buffer.
2. Transcribe the buffer each frame → emit a **partial** transcript.
3. On a silence frame after speech → emit a **final** and clear the buffer.

For the Ghanaian-accent-tuned variant, see
[`../moonshine-african/`](../moonshine-african/).
