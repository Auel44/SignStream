# async stack

Everything that lives between "the client sent audio" and "the client
received a sign ID": the audio queue, the event bus, and the three
Lambdas that consume from those channels.

## Resources

| File | Resources |
| --- | --- |
| `queues.tf` | `audio-queue` SQS + `audio-dlq` DLQ + redrive policies + SSM parameters |
| `event_bus.tf` | `signstream-bus` EventBridge bus + `signstream.transcript` rule |
| `iam.tf` | Per-Lambda execution roles with least-privilege inline policies |
| `lambda_asr.tf` | asr Lambda (container from ECR) + SQS event source mapping |
| `lambda_text_to_gloss.tf` | text-to-gloss Lambda + EventBridge target |
| `lambda_health_warmer.tf` | health-warmer Lambda + EventBridge Scheduler rule |

## The circular-dependency workaround

`asr` and `text-to-gloss` need `WEBSOCKET_ENDPOINT` (created by the `api`
stack) to push messages back to clients. But on a fresh deployment the
`api` stack hasn't been applied yet.

`main.tf` uses `aws_ssm_parameters_by_path` with a `try()` fallback so the
first `terraform apply` sets `WEBSOCKET_ENDPOINT=""`. The Lambdas boot and
run — the SQS/EventBridge paths work — but `push_to_client()` calls are
no-ops until the second `terraform apply` picks up the real URL after the
`api` stack has been deployed.

This is documented in the top-level [README](../../README.md#deploy-order-first-time).

## Cross-stack dependencies

**Reads (from SSM):**
- `/signstream/<env>/storage/connections/table_name`
- `/signstream/<env>/storage/connections/table_arn`
- `/signstream/<env>/storage/ecr/asr`
- `/signstream/<env>/storage/ecr/text-to-gloss`
- `/signstream/<env>/storage/ecr/health-warmer`
- `/signstream/<env>/api/websocket/management_url` (optional; empty on first deploy)

**Writes (to SSM):**
- `/signstream/<env>/async/audio_queue/url`
- `/signstream/<env>/async/audio_queue/arn`
- `/signstream/<env>/async/audio_dlq/arn`
- `/signstream/<env>/async/event_bus/name`
- `/signstream/<env>/async/event_bus/arn`

## Notable variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `asr_memory_mb` | 2048 | Lambda memory. Higher = more CPU. Bump if the ASR model is slow. |
| `asr_timeout_seconds` | 30 | Longer than audio_queue visibility_timeout must never happen. |
| `asr_model` | `stub` | Which engine to run in production. |
| `audio_queue_visibility_timeout_seconds` | 60 | Must exceed `asr_timeout_seconds`. |
| `audio_queue_max_receive_count` | 3 | Failures per message before DLQ. |
| `warmer_schedule` | `rate(5 minutes)` | How often the health-warmer fires. |
