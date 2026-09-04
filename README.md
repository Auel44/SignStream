# SignStream

**A browser extension that watches a video's audio and signs it, live, as a 3D
avatar overlaid on the page.**

A Deaf viewer opens YouTube. The extension captures the tab's audio, transcribes
it in the cloud, maps the words to sign glosses, and an avatar in the corner of
the video performs them — in Ghanaian Sign Language or American Sign Language.

Captions already exist. Captions are also not most Deaf people's first language:
for a signer, English text is a second language read at a disadvantage, while a
signed rendering is simply the message. This is that rendering.

KNUST final-year project. Supervisor documents are in [`docs/supervisor/`](docs/supervisor/).

---

## What it is, and what it is not

| | |
| --- | --- |
| **One-way** | Audio → sign. There is no sign → speech path; that is out of scope. |
| **Not video conferencing** | It overlays a page you are already watching. |
| **ASL and GhSL** | BSL is deliberately blocked — no public BSL keypoint dataset exists, so offering it would show a Deaf user an avatar standing still. |
| **No AI on the client** | All inference is cloud-side, so a low-spec laptop is never excluded. The browser only renders. |

---

## How it works

```text
tab audio (chrome.tabCapture)
    │  16 kHz mono PCM, 250 ms frames
    ▼
offscreen document ──WebSocket──► API Gateway
                                      │
                                      ▼
                            ws-audio-ingest → asr  (Moonshine ONNX)
                                      │
                                      ▼
                            text-to-gloss   "thank you" → THANK-YOU → asl-thank-you-v1
                                      │
    ┌───────────── signId ◄────────────┘
    ▼
service worker ──relay──► content script
                              │  fetch <cdn>/asl/asl-thank-you-v1.json
                              ▼
                        Three.js avatar plays the keypoint clip
```

The avatar is not generated. Every sign is a **pre-recorded clip of keypoints**
— where a human signer's joints actually were — replayed onto a rigged model at
runtime. That is why it needs no GPU and why the vocabulary is bounded by the
data rather than by the code.

### Two things called "dictionary"

This trips everyone up, including the people who wrote it:

- `backend/functions/text-to-gloss/dictionaries/` — **word → gloss label**
- `dictionary/` — **gloss label → motion clip**

### Live captions bypass the ASR entirely

When a video already publishes a caption track, its text is used directly, with
the media timestamp attached. Signs are then scheduled for the moment the words
are spoken rather than played on arrival — real synchronisation, not a guess.
Moonshine runs only when there are no captions (live streams, or unsubtitled
video).

---

## Repository layout

```text
extension/          The Chrome MV3 extension (TypeScript, Vite, React, Three.js)
  src/content/      Overlay, avatar, retargeting, clip fetching, video sync
  src/background/   Service worker — capture lifecycle and message routing
  src/offscreen/    Tab audio capture and the WebSocket to the cloud
  public/           12 avatars (.vrm)

backend/
  functions/        Lambdas: ws-connect, ws-audio-ingest, asr, text-to-gloss, …
  layers/common/    Shared message schemas and helpers
  infrastructure/   Terraform
  scripts/          test-all.sh, upload-dictionary.py, build-alphabets.py

dictionary/         3,199 keypoint clips — asl/ (1,981) and ghsl/ (1,218)
pose-generator/     Offline: raw keypoints or video → dictionary clips
dev/                Docker Compose stack: the whole cloud pipeline on a laptop
tools/rt/           Offline harnesses that run the shipped retargeting in Node
docs/supervisor/    SRS, Software Design Document, Test Plan, Progress Report
tools/docs/         Generator for the project explainer (.docx)
```

---

## Running it

### Local stack

```bash
docker compose -f dev/docker-compose.yml up -d
```

This runs the real ASR engine, the real normaliser and the real gloss mapper
over a WebSocket, plus an nginx stand-in for the clip CDN. Only the AWS
transport is replaced — everything that decides *what the avatar signs* is the
production code.

### The extension

```bash
cd extension
npm install
npm run build          # type-check, then build to dist/
```

Load `extension/dist` at `chrome://extensions` with Developer Mode on.

### Tests

```bash
cd backend && bash scripts/test-all.sh     # 7 suites
cd pose-generator && python -m pytest -q
node tools/rt/build.mjs && node tools/rt/smooth.mjs   # avatar retargeting
node tools/rt/tabs.mjs                                # overlay tab isolation
```

Root-level `pytest` will **not** work: every Lambda has its own `tests` package
of the same name. `scripts/test-all.sh` is the entry point.

`tools/rt/` runs the *shipped* TypeScript in Node against the real avatar files
and real clips. Rebuild its bundle after touching `rigs.ts` or `retarget.ts` —
a stale bundle passes while testing code that is no longer shipped.

---

## Current state

| | |
| --- | --- |
| GhSL vocabulary | 1,198 signs + 20 letters |
| ASL vocabulary | 1,981 signs + 20 letters |
| Avatars | 12, all VRM, 40 driven bones each |
| Backend tests | 7 suites passing |
| Retargeting | 0 unmapped bones on all 12 rigs; smoothing removes ~90% of jerk |

### Known limits, stated plainly

- **Fingerspelling is off.** Both languages have 20 of 26 letters (missing
  `a c l x y z`). A word is only spelled when *every* letter has a clip, because
  a guessed handshape is a wrong letter, not an approximate one. The wiring is
  complete on both the dev and production paths and switches itself on when the
  six clips land.
- **The clips are 2D.** The source keypoints carry no depth (`z = 0`), so
  handshape fidelity is bounded by what a 2D tracker could see.
- **Signing is slower than speech.** A sign runs ~2.4 s while speech delivers
  2–3 words per second, so signs expire after 6 s rather than accumulating lag.
  The avatar shows what it can, in time, instead of everything, late.
- **Nothing is deployed.** Terraform is written; the extension points at
  localhost.
- **ASL is not commercially usable** — see below.

---

## Licensing

The sign data carries obligations, and one of them is a hard limit:

- **ASL clips derive from WLASL, under C-UDA — academic and computational use
  only, no commercial use.**
- **GhSL clips derive from the Ghanaian Sign Language Lexicon (CC BY 4.0)** and
  require attribution plus a note that they were modified, wherever they go.
- Avatars are CC0 by Polygonal Mind.

Full detail, in the form each licence asks for, is in
**[ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md)** — read it before distributing
anything.
