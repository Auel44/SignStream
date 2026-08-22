# Lambda container image for ws-audio-ingest.
# Build context: `backend/`.

FROM public.ecr.aws/lambda/python:3.11

COPY layers/common /tmp/signstream_common
RUN pip install --no-cache-dir /tmp/signstream_common

COPY functions/ws-audio-ingest/requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

COPY functions/ws-audio-ingest/handler.py ${LAMBDA_TASK_ROOT}/

CMD ["handler.handler"]
