# monitoring stack

Cost guardrails, health alarms, and one dashboard.

## Resources

| File | What it creates |
| --- | --- |
| `alerts.tf` | SNS topic + optional email subscription for all alarms. |
| `billing_alarm.tf` | CloudWatch billing alarm at ${var.billing_alarm_threshold_usd} USD/month (us-east-1 provider — that is where billing metrics live). |
| `dlq_alarm.tf` | Fires when the audio DLQ contains ≥ 1 message — something upstream is failing beyond retry. |
| `dashboard.tf` | One CloudWatch dashboard with Lambda invocations / errors / duration + audio queue backlog + DLQ depth. |

## Cross-stack dependencies

**Reads (from SSM):**
- `/signstream/<env>/async/audio_dlq/arn`

**Writes:** none (this stack is a consumer of state).

## Variables worth setting

| Variable | Purpose |
| --- | --- |
| `billing_alarm_threshold_usd` | Default 5 USD. Raise for production. |
| `alert_email` | Set to receive billing + DLQ alerts. Leave empty to skip email. |
| `dlq_alarm_threshold_messages` | Default 1 — alarm fires the moment a message lands in the DLQ. |

## Apply

```bash
terraform init
terraform apply \
  -var environment=staging \
  -var alert_email=you@example.com
```

You will get a confirmation email from SNS for both the regional and
us-east-1 topics. Click both to enable alerts.
