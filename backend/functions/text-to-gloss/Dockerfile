# Lambda container image for text-to-gloss.
# Build context: `backend/`.

FROM public.ecr.aws/lambda/python:3.11

# Shared layer first (cached).
COPY layers/common /tmp/signstream_common
RUN pip install --no-cache-dir /tmp/signstream_common

# Function deps.
COPY functions/text-to-gloss/requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# Function code + bundled per-language dictionaries.
COPY functions/text-to-gloss/handler.py \
     functions/text-to-gloss/normaliser.py \
     functions/text-to-gloss/mapper.py \
     functions/text-to-gloss/publisher.py \
     ${LAMBDA_TASK_ROOT}/
COPY functions/text-to-gloss/dictionaries ${LAMBDA_TASK_ROOT}/dictionaries

CMD ["handler.handler"]
