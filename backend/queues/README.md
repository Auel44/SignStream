# queues — SQS Queue Manifests

The **authoritative description of every queue** in SignStream. One YAML
file per queue records its purpose, message shape, retention policy, and
dead-letter topology.

**These files are documentation, not runtime config.** The queues
themselves are created by the Terraform in
[`../infrastructure/stacks/async/queues.tf`](../infrastructure/stacks/async/queues.tf).
This directory records the design so:

1. New engineers can see what queues exist without reading Terraform.
2. A CI check can diff the Terraform against these manifests to catch
   drift (planned — not yet wired up).
3. The message-shape link points back to `../events/*.json` so producers
   and consumers cannot forget which schema owns each message body.

## Contents

| File | Queue | Purpose |
| --- | --- | --- |
| [`audio-queue.yaml`](audio-queue.yaml) | `signstream-<env>-audio-queue` | 250 ms PCM frames from `ws-audio-ingest` → `asr` |
| [`audio-dlq.yaml`](audio-dlq.yaml) | `signstream-<env>-audio-dlq` | Dead-letter queue for `audio-queue` — messages that failed 3 retries land here |

## Manifest format

Every file follows the same shape:

```yaml
name: signstream-<env>-<queue-name>
purpose: One-line description of what this queue is for.
producers:
  - lambda: which Lambda writes to it, using which action
consumers:
  - lambda: which Lambda reads from it
message_body_schema: ../events/<schema>.json    # relative to this file
retention_seconds: 14400
visibility_timeout_seconds: 60
max_receive_count: 3
dead_letter_target: <name of DLQ, or null>
notes: |
  Free-form.
```

## Why "queues" is a separate directory (not part of `events/`)

- **events/** describes **message shapes** — the data on the wire.
- **queues/** describes **transport channels** — where those messages
  live and how they are re-tried.

Two messages of the same shape can travel through different queues with
different retention or DLQ policies, so the two concerns are kept apart.
