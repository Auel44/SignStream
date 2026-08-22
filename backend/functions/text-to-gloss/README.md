# text-to-gloss — Transcript → Sign IDs

Consumes `signstream.transcript` events published by the `asr` Lambda,
converts each finalised transcript into a sequence of dictionary sign IDs,
and pushes them to the originating WebSocket client so the avatar can
animate them. Also fans out a `signstream.signId` event per sign for
downstream observers (analytics, logging).

## Files at a glance

| File | Job |
| --- | --- |
| `handler.py` | Lambda entry point; consumes EventBridge events, orchestrates normalise → map → publish; also answers the health-warmer sentinel. |
| `normaliser.py` | Cleans free-form English: lowercase, drop punctuation, expand contractions ("don't" → "do not"). |
| `mapper.py` | Greedy longest-match n-gram lookup against a per-language dictionary. Emits `MappedSign` records with the canonical `<lang>-<gloss>-v1` sign ID. |
| `publisher.py` | Wraps EventBridge `PutEvents` and API Gateway management API `PostToConnection`. Handles stale connections gracefully. |
| `dictionaries/asl.json`, `bsl.json`, `ghsl.json` | English phrase → gloss label mappings. Add entries to grow the vocabulary. |
| `requirements.txt` | boto3 only. |
| `Dockerfile` | Small container image (~150 MB). Deployed the same way as the asr Lambda for build-pipeline consistency. |
| `tests/` | Pytest suite covering the normaliser, mapper, and full handler flow. |

## Design decisions

### Why greedy longest-match

Sign languages collapse and expand English inconsistently: "thank you" is
one sign (`THANK-YOU`), but "i am tired" is at least three. A greedy
matcher tries the longest phrase first at each position, then falls back
to shorter ones. This gives short-phrase priority (`THANK-YOU` wins over
signing `THANK` + `YOU` separately) while degrading naturally when no
match exists.

### Why unknown words are dropped silently

The caption transcript is always displayed by the client, so a word we
cannot sign is not lost — the user still reads it. Dropping saves an
avatar animation that would either be a fingerspelling loop (long) or a
placeholder sign (misleading). This is graceful degradation.

### Why partials are ignored

The asr Lambda emits both partial and final transcripts. Partials drive
live captions on the client but should not drive avatar animation — the
avatar would sign each intermediate word and re-sign the revised version
half a second later. Only finalised transcripts produce signs.

### Why dictionaries are bundled JSON, not S3

Bundling in the Lambda deploys atomically with the code. Loading from S3
would let the dictionary grow without redeploying, but adds an extra
network fetch on cold start and a moving target during troubleshooting.
Once the vocabulary stabilises we can move to S3.

## Environment variables

| Name | Required | Default | Purpose |
| --- | --- | --- | --- |
| `WEBSOCKET_ENDPOINT` | yes | — | API Gateway management URL (e.g. `https://<id>.execute-api.eu-west-1.amazonaws.com/prod`). |
| `EVENT_BUS_NAME` | no | `signstream-bus` | EventBridge bus that carries `signstream.signId` events. |
| `EVENT_SOURCE` | no | `signstream.text-to-gloss` | EventBridge event `source` attribute. |
| `LOG_LEVEL` | no | `INFO` | Standard Python logging level. |

## IAM permissions required

| Action | Resource |
| --- | --- |
| `events:PutEvents` | the `signstream-bus` ARN |
| `execute-api:ManageConnections` | `arn:aws:execute-api:eu-west-1:<account>:<api-id>/<stage>/POST/@connections/*` |
| `logs:CreateLogStream`, `logs:PutLogEvents` | the function's CloudWatch log group |

The function does NOT need SQS permissions — it subscribes to
EventBridge, which delivers events synchronously via a Lambda target
configured in the `async` IaC stack.

## Local testing

```bash
cd backend/functions/text-to-gloss
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r tests/requirements.txt
pytest -v
```

## Growing the dictionary

Open the appropriate `dictionaries/<lang>.json` and add entries. Keys are
lowercase English phrases (space-separated). Values are gloss labels
(uppercase, hyphens between words in a single sign). Redeploy the
function — the change takes effect on the next cold start.

Example:

```json
{
  "how are you": "HOW-YOU",
  "video call": "VIDEO-CALL"
}
```

Generates sign IDs `asl-how-you-v1` and `asl-video-call-v1`.
