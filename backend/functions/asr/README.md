# asr — Streaming Speech Recognition Lambda

Consumes 250 ms PCM audio frames from the SQS `audio-queue`, runs streaming
speech recognition, and emits transcripts on two paths in parallel:

1. **EventBridge `signstream.transcript`** — so the `text-to-gloss` Lambda
   can react and map the words to sign IDs.
2. **API Gateway management API push** — so the client sees live captions
   immediately, without waiting for the gloss stage.

The function follows the SignStream loose-coupling rules: it knows about its
inputs (the SQS schema) and its outputs (the EventBridge schema and the
WebSocket wire protocol) but nothing about which Lambda runs before or after
it.

## Files

| File | Responsibility |
| --- | --- |
| `handler.py` | Lambda entry point. Iterates an SQS batch, dispatches per record, returns `batchItemFailures` so the queue only re-drives broken messages. |
| `asr_engine.py` | Pluggable ASR engine. Default `StubEngine` is fully functional for demos and tests. `MoonshineEngine` is the real CPU engine (Moonshine ONNX, MIT-licensed). `AfricanMoonshineEngine` loads an AfriSpeech-fine-tuned checkpoint. Parakeet (GPU) and MMS are documented as future plugins. |
| `session_state.py` | Per-connection LRU cache with TTL. Holds the engine's streaming state across frames so the model keeps context within a session. |
| `publisher.py` | Wraps EventBridge `PutEvents` and API Gateway management API `PostToConnection`. Gracefully handles stale (`Gone`) connections. |
| `requirements.txt` | Python runtime dependencies. |
| `Dockerfile` | Lambda container image. Moonshine ONNX is light enough to fit a zip, but we package as a container for consistency with the other Lambdas and to pre-bake the model into the image. |
| `tests/` | Pytest suite — handler, cache, engine, publisher (with mocked AWS). |

## Why session state is in-memory (and not in DynamoDB)

Streaming ASR carries a tensor of model state across consecutive frames of
the same session. Two options were considered:

1. **In-memory LRU cache** keyed by `connectionId`, lives in the warm Lambda
   container.
2. **Serialise the state to DynamoDB or ElastiCache** between every
   invocation.

Option 1 was chosen because: (a) Lambda warm containers persist for 5 to 15
minutes — long enough to cover most listening sessions; (b) per-frame
DynamoDB round-trips would add 5 to 15 ms each, which would dominate
end-to-end latency; (c) when a cache miss does happen (cold start, container
recycle, session migrates to a different container) the model simply starts
fresh on the next frame — a small quality dip, not a failure.

## Environment variables

| Name | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ASR_MODEL` | no | `stub` | One of `stub`, `moonshine` (CPU, recommended), `moonshine-african` (AfriSpeech-tuned, recommended for Ghana), `parakeet-tdt-streaming` (GPU, planned), `mms` (planned). |
| `ASR_MOONSHINE_MODEL` | no | `moonshine/base` | Preset for `ASR_MODEL=moonshine`: `moonshine/tiny` (fastest) or `moonshine/base` (more accurate). |
| `ASR_MOONSHINE_MODEL_PATH` | conditional | — | Required when `ASR_MODEL=moonshine-african`. Local directory of the fine-tuned ONNX model files (e.g. `/opt/model/moonshine-african`). |
| `WEBSOCKET_ENDPOINT` | yes | — | API Gateway management URL (e.g. `https://<id>.execute-api.eu-west-1.amazonaws.com/prod`). |
| `EVENT_BUS_NAME` | no | `signstream-bus` | EventBridge bus that carries `signstream.transcript` events. |
| `EVENT_SOURCE` | no | `signstream.asr` | EventBridge event `source` attribute. |
| `SESSION_CACHE_SIZE` | no | `128` | Max number of concurrent connections held in the in-memory cache. |
| `SESSION_TTL_SECONDS` | no | `600` | Idle TTL after which an entry is evicted (10 minutes). |
| `LOG_LEVEL` | no | `INFO` | Standard Python logging level. |

## IAM permissions required

| Action | Resource |
| --- | --- |
| `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` | the `audio-queue` ARN |
| `events:PutEvents` | the `signstream-bus` ARN |
| `execute-api:ManageConnections` | `arn:aws:execute-api:eu-west-1:<account>:<api-id>/<stage>/POST/@connections/*` |
| `logs:CreateLogStream`, `logs:PutLogEvents` | the function's CloudWatch log group |

## Local testing

```bash
cd backend/functions/asr
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r tests/requirements.txt
pytest -v
```

## Deploying

The function is packaged as a container image (built from the `backend/`
context so the shared layer and the pre-baked Moonshine model are included):

```bash
# from backend/
docker build -f functions/asr/Dockerfile -t signstream-asr:latest .
# Tag and push to ECR, then point your Lambda function at the image URI.
```
