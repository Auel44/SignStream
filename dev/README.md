# Local dev stack

Runs the parts of SignStream that decide **what the avatar signs**, on your
machine, so the extension can be tested end to end without AWS.

```bash
docker compose -f dev/docker-compose.yml up -d --build
python dev/e2e-check.py          # verify the whole path
```

Then load `extension/dist/` at `chrome://extensions` → *Load unpacked*
(Developer mode on). The build already points at this stack — see
`extension/.env.local`.

| Service | Port | Stands in for |
| --- | --- | --- |
| `gateway` | 8080 | API Gateway WebSocket + `ws-audio-ingest` + `asr` + `text-to-gloss` |
| `dictionary` | 8081 | S3 + CloudFront clip CDN |

## Watching the pipeline

One pane shows all four stages, in order, as they happen:

```bash
docker compose -f dev/docker-compose.yml logs -f
```

Each line is numbered by stage:

```text
1 AUDIO  frame #17    8000 bytes   250.0 ms  [########....] rms=0.104
2 ASR    partial 'the doctor said'
2 ASR    FINAL   'the doctor said thank you'
3 GLOSS  tokens ['the', 'doctor', 'said', 'thank', 'you']
3 GLOSS  doctor                   → DOCTOR             → ghsl-doctor-v1
3 GLOSS  thank you                → THANK_YOU          → ghsl-thank-you-v1
3 GLOSS  no sign for: the, said
3 GLOSS  2 sign(s) sent to the client
4 CLIP   200  /ghsl/ghsl-doctor-v1.json  128528B
4 CLIP   200  /ghsl/ghsl-thank-you-v1.json  147002B
```

| Stage | Proves |
| --- | --- |
| `1 AUDIO` | The browser captured tab audio and it reached the backend. `rms` is the level — near 0 means silence is being captured. |
| `2 ASR` | Speech became text. `partial` refines as more audio arrives; `FINAL` is what drives signing. |
| `3 GLOSS` | Words matched dictionary entries and became sign ids. `no sign for:` lists words with no sign — a skip, not a failure. |
| `4 CLIP` | The extension fetched the keypoints. `200` with a byte count means the avatar has real animation data. |

A `4 CLIP` line with `404` means the sign id had no clip on disk — that is the
one case where the avatar would receive a sign it cannot play.

The browser side has its own two consoles, at `chrome://extensions` →
*Details* → *Inspect views*:

- **service worker** — `[SignStream] frame #N ... rms=... sent=true` confirms
  capture and that frames are going out.
- the page's own **DevTools console** (F12 on the video tab) — clip cache
  misses and any avatar errors.

## What is real and what is not

The gateway imports the **actual** Lambda modules — `asr_engine`, `normaliser`,
`mapper` — and the real dictionaries and clips, mounted read-only. So
transcription, tokenising, greedy phrase matching, sign-id construction and
clip lookup all behave exactly as they do in production. Editing a dictionary
or the mapper takes effect on `docker compose restart gateway`, no rebuild.

What it deliberately does **not** reproduce: IAM, the SQS retry/DLQ path,
EventBridge fan-out, DynamoDB sequence numbers, and Lambda cold starts. Those
are transport and operational concerns; emulating them would mostly test the
emulator. Nothing here is safe to expose — no auth, no rate limiting.

## Choosing an ASR engine

```bash
ASR_MODEL=stub      docker compose -f dev/docker-compose.yml up -d   # default
ASR_MODEL=moonshine docker compose -f dev/docker-compose.yml up -d
```

`stub` needs no model at all. It watches audio activity and emits canned
sentences, which is the quickest way to confirm the avatar is signing — the
gloss, clip and rendering path downstream is identical either way.

`moonshine` transcribes real speech, and requires the ML wheels to be present
in the image. Check with:

```bash
docker compose -f dev/docker-compose.yml exec gateway python -c "import moonshine_onnx"
```

If that fails, rebuild — the wheels are ~200 MB and the install is skipped
rather than failing the build when the network drops:

```bash
docker compose -f dev/docker-compose.yml build --no-cache gateway
```

## Testing the avatar without speech

The gateway accepts a **dev-only** control message with no production
counterpart, which drives the real gloss mapper from text:

```json
{"action": "simulateTranscript", "text": "thank you doctor water"}
```

`dev/e2e-check.py` uses it to verify sign output deterministically. It is also
the fastest way to make the avatar sign a specific phrase on demand.

## URL layout

The extension requests `/<lang>/<sign-id>.json` — and a sign id already carries
its language, so: `/ghsl/ghsl-hello-v1.json`. On disk the clip is
`ghsl/hello-v1.json`, because the folder supplies the language.

In production `backend/scripts/upload-dictionary.py` resolves this by naming
each S3 object from the clip's own `signId` field. Here `nginx.conf` does the
same job with a read-only rewrite, so no files are duplicated.

## Troubleshooting

**No avatar.** Check the tab is playing audio and the extension is connected
(popup → Settings → Audio source). `docker compose logs -f gateway` shows every
transcript and the sign ids it emitted.

**Avatar appears but never moves.** The sign ids resolved to no clip. The
gateway logs `(no dictionary match)` when the words are not in the vocabulary —
GhSL has no HELLO recording, for instance.

**Clip 404s.** `curl -i http://localhost:8081/ghsl/ghsl-water-v1.json` should
return 200 with `Access-Control-Allow-Origin: *`.
