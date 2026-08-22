# api stack

The client-facing edge: an API Gateway v2 WebSocket API with three routes
wired to Lambdas.

## Resources

| File | Resources |
| --- | --- |
| `websocket.tf` | `aws_apigatewayv2_api` (WebSocket) + 3 integrations + 3 routes + stage + access log group |
| `iam.tf` | Per-Lambda execution roles (least-privilege) |
| `lambda_ws_connect.tf` | ws-connect Lambda + API GW invoke permission |
| `lambda_ws_disconnect.tf` | ws-disconnect Lambda + API GW invoke permission |
| `lambda_ws_audio_ingest.tf` | ws-audio-ingest Lambda + API GW invoke permission |

## Routes

| Route | Lambda | What it does |
| --- | --- | --- |
| `$connect` | ws-connect | Registers the session in DynamoDB Connections |
| `$disconnect` | ws-disconnect | Deletes the row (idempotent) |
| `$default` | ws-audio-ingest | Binary → SQS; JSON control → DynamoDB update |

## Cross-stack dependencies

**Reads (from SSM):**
- `/signstream/<env>/storage/connections/table_name` + `/table_arn`
- `/signstream/<env>/storage/ecr/ws-connect` + `/ws-disconnect` + `/ws-audio-ingest`
- `/signstream/<env>/async/audio_queue/url` + `/arn`

**Writes (to SSM):**
- `/signstream/<env>/api/websocket/client_url`   (wss://…)
- `/signstream/<env>/api/websocket/management_url` (https://…)
- `/signstream/<env>/api/websocket/api_id`

The async stack picks up `management_url` on its second `terraform apply`
to complete the ML-side push-back path.

## After deploy

Copy the `websocket_client_url` output into
`extension/src/shared/config.ts` as `WS_ENDPOINT`:

```ts
export const WS_ENDPOINT = "wss://<api-id>.execute-api.eu-west-1.amazonaws.com/prod";
```

Then rebuild the extension so the popup can reach the deployed backend.
