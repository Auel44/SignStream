# layers/common — Shared Lambda Utilities

A tiny Python package (`signstream_common`) that every SignStream Lambda
can install. It's not a Lambda **layer** in the AWS sense — since all
SignStream Lambdas ship as container images, this is instead a normal
Python package installed inside each image at build time.

## What's in it

| Module | Purpose |
| --- | --- |
| `logging` | `get_logger()` — structured JSON logger with `LOG_LEVEL` env override. CloudWatch Logs Insights parses each line as one object. |
| `time` | `now_iso()` — millisecond-precision ISO-8601 UTC timestamp used by every event and message. |
| `warmup` | `is_warmup(event)` + `WARMUP_RESPONSE` — the sentinel-check pattern used by every Lambda's handler. |
| `websocket` | `WebSocketPusher` — API Gateway management API wrapper with uniform `GoneException` handling. |
| `messages` | Constants for WebSocket `type` values, EventBridge `detail-type` values, and the `VALID_SIGN_LANGUAGES` set. |

## Consuming from a Lambda Dockerfile

Change the build context to `backend/` so the sibling `layers/` folder is
reachable, then install the package:

```dockerfile
FROM public.ecr.aws/lambda/python:3.11

# Install shared layer BEFORE function requirements so pip resolves them together.
COPY layers/common /tmp/signstream_common
RUN pip install --no-cache-dir /tmp/signstream_common

# Then the per-function requirements + code.
COPY functions/asr/requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt
COPY functions/asr/*.py ${LAMBDA_TASK_ROOT}/

CMD ["handler.handler"]
```

And build from the `backend/` directory:

```bash
docker build -f functions/asr/Dockerfile -t signstream-asr:latest .
```

`scripts/build-and-push-images.sh` does this for every Lambda automatically.

## Consuming from Python

```python
from signstream_common import get_logger, now_iso, is_warmup, WARMUP_RESPONSE, WebSocketPusher

log = get_logger(__name__)

def handler(event, _ctx):
    if is_warmup(event):
        return WARMUP_RESPONSE
    log.info("received event", extra={"connectionId": event.get("connectionId")})
    ...
```

## Local testing

```bash
cd backend/layers/common
pip install -e ".[test]"
pytest -v
```

## Migration status

The Lambdas currently vendor their own copies of `now_iso`, warm-up
detection, and the WebSocket push wrapper (this predates the layer). The
follow-up is a mechanical refactor — for each Lambda, delete the inline
helper and `from signstream_common import ...`. Deferred so the current
green tests stay green until the layer is proven in a first deploy.
