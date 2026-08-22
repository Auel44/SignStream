# SignStream — Backend (AWS Serverless)

Serverless backend for the SignStream one-way audio→sign pipeline. Region: **eu-west-1 (Ireland)**.
Everything here is designed to sit within the AWS always-free allowances at small scale, and to fail
**gracefully and in isolation** so that a fault in any single component does not take the rest down.

## Design principle: loose coupling and fault isolation

The pipeline never calls one function directly from another. Stages communicate through queues and an
event bus, so a slow, failing, or absent stage backs up its own queue instead of cascading a failure
through the system.

```
                         API Gateway (WebSocket)
                                  │
        ┌─────────────────┬──────┴───────┬──────────────────┐
        ▼                 ▼              ▼                    ▼
   ws-connect       ws-disconnect   ws-audio-ingest     (mgmt push back
   ($connect)       ($disconnect)   (default route)      to client)
        │                 │              │                    ▲
        ▼                 ▼              ▼                    │
   DynamoDB          DynamoDB        SQS audio queue          │
  (connections)     (connections)        │                   │
                                         ▼                    │
                                       asr  ──► EventBridge ──┤
                                    (transcript)   (event)    │
                                                     ▼        │
                                              text-to-gloss ──┘
                                              (sign ID lookup)
```

### Why this is loosely coupled

- **Independently deployable units** — every Lambda lives in its own folder under `functions/` with its
  own handler and dependencies. Any one can be redeployed, disabled, or fail without touching the others.
- **Split WebSocket routes** — `ws-connect`, `ws-disconnect`, and `ws-audio-ingest` are separate
  functions, so a fault in audio ingest cannot break connection registration or teardown.
- **Async stages, no synchronous chaining** — `ws-audio-ingest` only enqueues a chunk; `asr` consumes
  the queue and publishes an event; `text-to-gloss` reacts to that event. No stage waits on another.
- **Dead-letter queues (DLQs)** — failed messages land in a DLQ rather than blocking the pipeline; the
  rest of the system keeps serving while bad messages are inspected/replayed.
- **Split infrastructure stacks** — `api`, `async`, `storage`, and `monitoring` deploy independently, so
  a failed change in one stack does not roll back the others.
- **Graceful client degradation** — the avatar is driven by sign IDs and pose assets fetched from
  S3/CloudFront independently of the live transcript. If `text-to-gloss` or the dictionary is
  unavailable, the extension can still surface the transcript instead of failing outright.

## Directory layout

| Path | Responsibility |
|------|----------------|
| `functions/ws-connect/` | `$connect` route — register connection in DynamoDB |
| `functions/ws-disconnect/` | `$disconnect` route — clean up connection record |
| `functions/ws-audio-ingest/` | Default route — validate audio chunk, enqueue to SQS |
| `functions/asr/` | SQS consumer — streaming ASR (Parakeet / Moonshine) → transcript → EventBridge |
| `functions/text-to-gloss/` | Event consumer — normalise text → gloss → sign ID → push to client |
| `functions/health-warmer/` | Scheduled keep-warm / health probe (mitigates cold starts) |
| `layers/common/` | Shared Lambda layer: logging, DynamoDB client, API-GW management client |
| `events/` | Event/message schemas — the contract between stages |
| `queues/` | SQS queue + dead-letter-queue definitions |
| `infrastructure/stacks/` | Per-concern IaC stacks: `api`, `async`, `storage`, `monitoring` |
| `scripts/` | Deploy / teardown helpers |

## Cost control

- All services chosen sit within AWS always-free monthly allowances at the project's scale.
- CloudWatch billing alarms are configured from the outset (`monitoring` stack).
- The Elastic Load Balancer and NAT Gateway are deliberately avoided — they are not free-tier and are the
  most common sources of unexpected charges. Concurrency and load distribution come from Lambda +
  API Gateway being inherently horizontally scaling and multi-tenant.
- Heavy pose-generation (stretch goal) runs locally/offline, never on paid cloud compute.

## Privacy

Audio chunks are processed transiently in Lambda and are never persisted.
