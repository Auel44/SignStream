# ws-audio-ingest — API Gateway WebSocket Default Route

The one WebSocket route the client hits repeatedly during a session.
Handles two kinds of message:

1. **Binary audio frames** — 250 ms Int16 PCM at 16 kHz mono, four
   times per second per user. Wrapped in the audio-frame schema envelope
   and dropped on SQS. The `asr` Lambda picks up the queue.
2. **JSON control messages** — currently just `setLanguage`. Mutates the
   Connections row so the next inbound frame carries the new language.

## Flow — binary frame

```
   client sends WS binary   (250 ms Int16 PCM)
              │
              ▼
   API Gateway sets  isBase64Encoded=True   body=<base64>
              │
              ▼
   this Lambda:
     1. atomic UpdateItem on Connections  → new sequence + lastSeenAt
        (ConditionExpression: connection must already exist)
     2. build audio-frame payload
        { connectionId, sequence, language, frame, capturedAt }
     3. SQS SendMessage to audio-queue
     4. return 200
              │
              ▼
        asr Lambda (async)
```

Zero synchronous ASR here — the queue absorbs bursts and lets the ASR
Lambda scale independently.

## Flow — control message

```
   client sends WS text   {"action":"setLanguage","language":"BSL"}
              │
              ▼
   API Gateway sets  isBase64Encoded=False   body=<utf8 json>
              │
              ▼
   this Lambda:
     1. parse JSON
     2. UpdateItem on Connections  → language + lastSeenAt
     3. return 200
```

## Files

| File | Job |
| --- | --- |
| `handler.py` | Route dispatcher (binary vs JSON) + both handlers + warmup sentinel. |
| `requirements.txt` | boto3 only. |
| `Dockerfile` | Same container pattern as the other Lambdas. |
| `tests/` | Pytest suite. |

## Why the sequence lives in DynamoDB

The client sends raw PCM with no header, so the sequence number in the
audio-frame schema has to come from the server. `UpdateItem` with `ADD`
is DynamoDB's atomic-number operator: it hands us the next sequence
without a read-modify-write race, even under concurrent invocations.

At small scale (four writes per second per user) this is well inside the
free tier. If SignStream ever reached millions of concurrent users the
per-frame DynamoDB write would become the cost hotspot; the follow-up
would be to move the sequence to a lightweight client-side header (4
bytes prepended to each binary frame) so the server can just read it.

## Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `CONNECTIONS_TABLE` | yes | DynamoDB table name for connection sessions. |
| `AUDIO_QUEUE_URL` | yes | SQS queue URL of the audio-queue. |
| `LOG_LEVEL` | no | Standard Python log level (default `INFO`). |

## IAM

| Action | Resource |
| --- | --- |
| `dynamodb:UpdateItem` | the Connections table ARN |
| `sqs:SendMessage` | the audio-queue ARN |
| `logs:CreateLogStream`, `logs:PutLogEvents` | this function's log group |
