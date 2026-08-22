# ws-disconnect — API Gateway WebSocket `$disconnect` Route

Cleans up the DynamoDB Connections row when a client closes the WebSocket.

## Flow

1. API Gateway calls this Lambda with a `$disconnect` event whose
   `requestContext.connectionId` matches the departing socket.
2. The Lambda issues `DeleteItem` on the Connections table.
3. Returns 200 whether or not the row existed — this handler is idempotent.

## Files

| File | Job |
| --- | --- |
| `handler.py` | Deletes the connection row; tolerates already-gone rows. |
| `requirements.txt` | boto3 only. |
| `Dockerfile` | Same container pattern as the other Lambdas. |
| `tests/` | Pytest suite. |

## Why idempotent

Two paths can end a connection:

1. The client explicitly closes → API Gateway fires `$disconnect`.
2. The Connections row is TTL-evicted after 1 hour of inactivity.

If (2) happens first, path (1) still fires but there is nothing to delete.
Failing on that would spam CloudWatch with false alarms; we log and return 200.

## Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `CONNECTIONS_TABLE` | yes | DynamoDB table name for connection sessions. |
| `LOG_LEVEL` | no | Standard Python log level (default `INFO`). |

## IAM

| Action | Resource |
| --- | --- |
| `dynamodb:DeleteItem` | the Connections table ARN |
| `logs:CreateLogStream`, `logs:PutLogEvents` | this function's log group |
