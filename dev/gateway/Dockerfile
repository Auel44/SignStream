# Local dev gateway. Deliberately NOT the Lambda image — that one targets the
# Lambda runtime interface, which cannot hold a long-lived WebSocket.
FROM python:3.12-slim

WORKDIR /app

# onnxruntime needs libgomp; curl is for the compose healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

# Moonshine is optional: the stub engine exercises the whole pipeline with no
# model at all, so the image stays usable even if the ML wheels cannot be
# fetched. Install it in its own layer so a failure here does not invalidate
# the rest of the build.
ARG INSTALL_MOONSHINE=1
# Quote every specifier: unquoted `websockets>=13` is a shell redirect, not a
# version constraint.
RUN pip install --no-cache-dir "websockets>=13"

# Moonshine pulls ~40 MB of wheels (onnxruntime is 19 MB alone) and the link to
# PyPI can sit at tens of kB/s, so a plain install times out repeatedly and
# restarts from zero each time.
#
# The cache mount is what makes this survivable: pip keeps every wheel it has
# already fetched in the BuildKit cache, so a retry resumes instead of
# re-downloading. Hence no --no-cache-dir here — the opposite of the usual
# image-size advice, and correct for exactly this reason.
#
# The bare `import` afterwards has no `||` on purpose: a silent fallback here
# produced an image that built "successfully" with no ASR in it.
RUN --mount=type=cache,target=/root/.cache/pip \
    if [ "$INSTALL_MOONSHINE" = "1" ]; then \
      pip install --timeout 300 --retries 20 \
        "useful-moonshine-onnx>=20251120" "numpy>=1.26,<3" \
      && python -c "import moonshine_onnx, onnxruntime" \
      && echo "MOONSHINE: installed and importable"; \
    else \
      echo "MOONSHINE: skipped (INSTALL_MOONSHINE=0) — stub engine only"; \
    fi

# Pre-download the model so the first utterance is not stalled behind a ~100 MB
# fetch. Mirrors what the asr Lambda's Dockerfile does at build time.
ARG ASR_MOONSHINE_MODEL=moonshine/tiny
ENV ASR_MOONSHINE_MODEL=${ASR_MOONSHINE_MODEL}
RUN python -c "import numpy as np, moonshine_onnx; moonshine_onnx.transcribe(np.zeros(16000, dtype='float32'), '${ASR_MOONSHINE_MODEL}')" \
    || echo "Skipping model pre-download (not installed or fetch blocked)."

COPY dev/gateway/server.py /app/server.py

# The weights are baked in above, but the HF client still revalidates them
# against the Hub on every load — a network round trip per inference, which on
# a 250 ms frame cadence dominates the latency and fails outright offline.
# Pin it to the local cache.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "/app/server.py"]
