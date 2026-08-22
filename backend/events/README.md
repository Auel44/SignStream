# Event and Message Schemas

This directory holds the **shape definitions** for every message that flows
between stages of the SignStream backend pipeline. Each file is a
[JSON Schema (Draft 2020-12)](https://json-schema.org/draft/2020-12/release-notes)
describing one event or queue message.

## Why this directory exists

The pipeline is intentionally loosely coupled: stages communicate through queues
and an event bus, never through direct in-process calls. That decoupling is only
safe if every stage agrees on the shape of the messages it sends and receives.
These schemas are that agreement — written down once, validated by every
producer and every consumer, so a typo in one Lambda cannot silently break
another.

## Contents

| File | Where it travels | Producer → Consumer |
| --- | --- | --- |
| [audio-frame.json](audio-frame.json) | SQS `audio-queue` | `ws-audio-ingest` → `asr` |
| [transcript.json](transcript.json) | EventBridge `signstream.transcript` | `asr` → `text-to-gloss` |
| [sign-id.json](sign-id.json) | EventBridge `signstream.signId` | `text-to-gloss` → (analytics / observers) |

The schemas describe the **payload only**. The SQS and EventBridge envelopes
around them (message IDs, attributes, `source`, `detail-type`) are added by AWS
and are not part of these contracts.

## How to use the schemas in a Lambda

Each Lambda imports its relevant schema at cold-start and validates inbound and
outbound messages against it.

### Python (Pydantic 2 via `datamodel-code-generator`)

```bash
# One-off: generate Python models from a schema.
pip install datamodel-code-generator
datamodel-codegen \
    --input events/transcript.json \
    --input-file-type jsonschema \
    --output backend/layers/common/schemas/transcript.py \
    --output-model-type pydantic_v2.BaseModel
```

```python
# In the Lambda handler:
from common.schemas.transcript import Transcript

def handler(event, _ctx):
    parsed = Transcript.model_validate(event["detail"])
    # parsed.text, parsed.is_final, parsed.connection_id …
```

### Node / TypeScript (Ajv)

```bash
npm install ajv
```

```ts
import Ajv from "ajv";
import schema from "../../events/transcript.json" assert { type: "json" };

const validate = new Ajv({ strict: true }).compile(schema);

export const handler = async (event) => {
  if (!validate(event.detail)) {
    throw new Error("invalid transcript event: " + JSON.stringify(validate.errors));
  }
  // …
};
```

## Versioning

Each schema's `$id` includes the major version of the message
(for example, `/v1/transcript.json`). Backwards-incompatible changes get a new
`$id` and a new file (`transcript.v2.json`); both versions ship side by side
during a rollout window so producers and consumers can be deployed
independently.

## Validation in CI

Continuous integration runs `ajv compile` against every file in this directory
on every push, so any malformed schema fails the build before it can be
referenced by a Lambda.
