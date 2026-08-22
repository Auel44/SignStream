# Lambda container image for the health-warmer.
# Build context: `backend/`.

FROM public.ecr.aws/lambda/python:3.11

COPY layers/common /tmp/signstream_common
RUN pip install --no-cache-dir /tmp/signstream_common

COPY functions/health-warmer/requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

COPY functions/health-warmer/handler.py ${LAMBDA_TASK_ROOT}/

CMD ["handler.handler"]
