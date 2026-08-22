# health-warmer — Scheduled Lambda Keep-Warm

Fires every few minutes on an EventBridge schedule and invokes the heavy
Lambdas (`asr`, `text-to-gloss`, etc.) with a sentinel payload so AWS keeps
their containers — and their loaded ML models — alive between real user
sessions.

This keeps cold-start latency out of the user experience without paying
for Provisioned Concurrency.

## Why this Lambda exists

| Lambda | Cold-start cost | Why it matters |
| --- | --- | --- |
| `ws-audio-ingest` | ~150–300 ms | Small, but adds to first-frame latency |
| `text-to-gloss` | ~200–400 ms | Adds to time-to-first-sign |
| **`asr`** | **~2–6 s** (loads the Moonshine ONNX model) | Would make the first sign appear seconds late |

A user enabling signing on a YouTube video must not wait several seconds
for the first sign. The warmer ensures the model is already loaded by the
time they arrive.

## How it works

1. EventBridge schedule (`every 5 minutes`) triggers this Lambda.
2. This Lambda reads `WARM_TARGETS` (comma-separated Lambda names).
3. For each target, it calls `lambda:Invoke` with `InvocationType=Event`
   (asynchronous, fire-and-forget) and the sentinel payload
   `{"warmup": true, "source": "health-warmer"}`.
4. Each target detects the sentinel at the top of its handler, runs
   `_bootstrap()` to load its in-memory state (model, cache, etc.), and
   returns immediately without doing real work.
5. AWS keeps the now-warm container alive for another 5–15 minutes.

## Files

| File | Responsibility |
| --- | --- |
| `handler.py` | Reads targets from env; issues async invokes; returns a summary. |
| `requirements.txt` | boto3 only. |
| `tests/` | Pytest suite — sentinel format, target parsing, partial failure handling. |

## Sentinel format

Every warmable Lambda must short-circuit when it sees this payload:

```python
def handler(event, _ctx):
    if isinstance(event, dict) and event.get("warmup"):
        _bootstrap()         # ensure in-memory state is loaded
        return {"warm": True}
    # … real work below
```

## Environment variables

| Name | Required | Default | Purpose |
| --- | --- | --- | --- |
| `WARM_TARGETS` | yes | (none) | Comma-separated Lambda function names to keep warm, e.g. `signstream-asr,signstream-text-to-gloss,signstream-ws-audio-ingest` |
| `LOG_LEVEL` | no | `INFO` | Standard Python logging level. |

## IAM permissions required

| Action | Resource |
| --- | --- |
| `lambda:InvokeFunction` | each ARN in `WARM_TARGETS` (use a list, not `*`) |
| `logs:CreateLogStream`, `logs:PutLogEvents` | the function's CloudWatch log group |

## Schedule

Configured in the `monitoring` IaC stack:

```hcl
resource "aws_scheduler_schedule" "warmer" {
  name                = "signstream-warmer"
  schedule_expression = "rate(5 minutes)"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_function.health_warmer.arn
    role_arn = aws_iam_role.warmer_scheduler.arn
  }
}
```

A 5-minute cadence balances warmth (containers idle for ~5–15 minutes) and
cost (8 640 invocations/month — well inside the always-free 1 M tier).

## Cost

Effectively zero at this project's scale:

- EventBridge schedule: free for the first 14 M invocations/month.
- This Lambda's own invocations: ~8 640/month → free tier (1 M/month).
- Async invokes of the targets: each returns in <1 ms via the sentinel —
  rounded down to 0.000004 USD per invocation at 128 MB; ~$0.04/month
  total across three targets.

## Local testing

```bash
cd backend/functions/health-warmer
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r tests/requirements.txt
pytest -v
```
