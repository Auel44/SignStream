# ws-connect — API Gateway WebSocket `$connect` Route

Registers a new client session in DynamoDB.

## Flow

1. Client opens `wss://<api>.execute-api.eu-west-1.amazonaws.com/prod`
   (optionally with `?language=BSL`).
2. API Gateway calls this Lambda with a `$connect` event whose
   `requestContext.connectionId` uniquely identifies the socket.
3. The Lambda writes a Connections row:
   `{ connectionId, language, sequence=0, connectedAt, lastSeenAt, expiresAt }`.
4. Returning `200` accepts the connection; anything else closes it.

## Files

| File | Job |
| --- | --- |
| `handler.py` | Reads the connect event, writes the Connections row. Answers the health-warmer sentinel. |
| `requirements.txt` | boto3 only. |
| `Dockerfile` | Same container pattern as the other Lambdas. |
| `tests/` | Pytest suite. |

## Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `CONNECTIONS_TABLE` | yes | DynamoDB table name for connection sessions. |
| `LOG_LEVEL` | no | Standard Python log level (default `INFO`). |

## IAM

| Action | Resource |
| --- | --- |
| `dynamodb:PutItem` | the Connections table ARN |
| `logs:CreateLogStream`, `logs:PutLogEvents` | this function's log group |

## DynamoDB Connections schema

| Attribute | Type | Purpose |
| --- | --- | --- |
| `connectionId` | S (partition key) | API Gateway WebSocket connection ID |
| `language` | S | Active sign language (`ASL`, `BSL`, `GhSL`) |
| `sequence` | N | Monotonic frame counter, atomic-incremented by ws-audio-ingest |
| `connectedAt` | S | ISO-8601 UTC |
| `lastSeenAt` | S | ISO-8601 UTC |
| `expiresAt` | N | Epoch seconds; DynamoDB TTL attribute |
