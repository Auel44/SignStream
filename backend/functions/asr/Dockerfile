# Lambda container image for the asr function.
#
# Build context: `backend/` (see scripts/build-and-push-images.sh).
# The shared layer at layers/common/ is installed before requirements
# so image rebuilds after layer edits only invalidate one docker layer.

FROM public.ecr.aws/lambda/python:3.11

# System deps for onnxruntime (Moonshine's inference backend).
RUN yum install -y --setopt=install_weak_deps=False \
        gcc gcc-c++ libstdc++ \
    && yum clean all \
    && rm -rf /var/cache/yum

# 1. Shared layer (rarely changes) → cached across function rebuilds.
COPY layers/common /tmp/signstream_common
RUN pip install --no-cache-dir /tmp/signstream_common

# 2. Function-specific deps.
COPY functions/asr/requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# 3. Function code.
COPY functions/asr/handler.py \
     functions/asr/asr_engine.py \
     functions/asr/session_state.py \
     functions/asr/publisher.py \
     ${LAMBDA_TASK_ROOT}/

# 4. Pre-download the default Moonshine ONNX model so the first cold start
#    does not pay the network-download cost. Skip silently if pip could not
#    resolve moonshine (stub-only build).
ARG ASR_MOONSHINE_MODEL=moonshine/base
ENV ASR_MOONSHINE_MODEL=${ASR_MOONSHINE_MODEL}
RUN python -c "import numpy as np, moonshine_onnx; moonshine_onnx.transcribe(np.zeros(16000, dtype='float32'), '${ASR_MOONSHINE_MODEL}')" \
    || echo "Skipping model pre-download (moonshine not installed or model fetch blocked)."

CMD ["handler.handler"]
