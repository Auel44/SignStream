# SignStream — Infrastructure (Terraform)

Four independently-deployable stacks. Region: **eu-west-1**. Region choice
matches the proposal: lowest reliable latency from Ghana while staying on
AWS's free tier.

## Stacks

| Stack | What it owns | Depends on |
| --- | --- | --- |
| `storage/` | DynamoDB Connections table, ECR repositories for every Lambda image | nothing |
| `async/` | SQS `audio-queue` + DLQ, EventBridge `signstream-bus`, `asr` / `text-to-gloss` / `health-warmer` Lambdas | `storage` (via SSM) |
| `api/` | API Gateway WebSocket API, `ws-connect` / `ws-disconnect` / `ws-audio-ingest` Lambdas | `storage` + `async` (via SSM) |
| `monitoring/` | Billing alarm, DLQ-depth alarms, dashboard, log-group retention | `async` + `api` (via SSM) |

Cross-stack references travel through **SSM parameters** rather than
`terraform_remote_state`. Each producing stack writes `/signstream/<env>/…`
parameters and consumers read them. That keeps state files independent and
lets any stack redeploy without importing the others.

## Deploy order (first time)

```bash
# 0. Set your target account and environment once.
export AWS_REGION=eu-west-1
export TF_VAR_environment=staging      # or 'production'

# 1. Storage first — nothing else works without the table and ECR repos.
cd stacks/storage
terraform init && terraform apply

# 2. Build & push the six Lambda container images to ECR.
cd ../../..
./scripts/build-and-push-images.sh

# 3. Async — creates the queues, event bus, and the ML-side Lambdas.
#    NOTE: on the first deploy, WEBSOCKET_ENDPOINT is unresolved (the api
#    stack has not created the WS API yet). asr and text-to-gloss will
#    boot but push_to_client() will silently fail until step 5.
cd backend/infrastructure/stacks/async
terraform init && terraform apply

# 4. API — creates the WebSocket API and the ws-* Lambdas.
cd ../api
terraform init && terraform apply

# 5. Re-apply async so it picks up the WS URL that api wrote to SSM.
cd ../async
terraform apply

# 6. Monitoring — alarms and dashboard.
cd ../monitoring
terraform init && terraform apply
```

Subsequent updates: just `terraform apply` in the stack that changed.

## State backends

Each stack defaults to **local state** for simplicity. For team use, uncomment
the S3 backend block at the top of `versions.tf` in each stack and provide the
bucket + DynamoDB lock table (typical Terraform-remote-state setup).

## Cost guardrails

* CloudWatch billing alarm is created in the `monitoring` stack with a **5 USD
  monthly threshold** (adjust via `var.billing_alarm_threshold_usd`).
* No load balancer or NAT Gateway anywhere — the two most common causes of
  surprise bills.
* All Lambdas use `PAY_PER_REQUEST` DynamoDB and on-demand SQS pricing so
  idle time costs nothing.

## Tearing everything down

Reverse of deploy order:

```bash
cd stacks/monitoring && terraform destroy
cd ../api            && terraform destroy
cd ../async          && terraform destroy
cd ../storage        && terraform destroy   # last — holds ECR images
```

Note: `terraform destroy` on `storage` will refuse if ECR repos contain images.
Empty them first or pass `force_delete = true` to the `aws_ecr_repository`
resources.
