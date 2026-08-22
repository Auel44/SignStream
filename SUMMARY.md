# SignStream — Project Handoff Summary

**Purpose of this file.** A cold-start briefing for a new assistant/account picking up this
work. It covers what the project is, what has been built, what was just fixed, and what is
still broken or unfinished.

**Last updated:** 2026-08-15

**Provenance note — read this before trusting anything below.** This file merges two sources:

1. **The avatar rendering/signing session (2026-08-12).** Written first-hand. Every claim from
   it was verified against the code and data at the time of writing, and the specific numbers
   are reproducible.
2. **The long prior session (2026-05-16 → 2026-08-12, 197 user turns).** I did **not** have this
   in context. I reconstructed it from the transcript on disk
   (`~/.claude/projects/c--Users-asant-Desktop-personal/c64a0468-….jsonl`) by reading the
   *user's* messages only. So the intent and decision history below are reliable, but the
   details of what was actually implemented in response are **inferred**. Where it mattered I
   re-checked against the repo; anything still unverified is marked "(unverified)".

---

## 1. What the project is

**SignStream** — a Manifest V3 **browser extension** that performs **one-way, real-time
translation of streaming-media audio into sign language**, rendered by a 3D avatar overlaid on
the page (YouTube etc.).

- **Direction: audio → sign only.** The reverse path (sign → text → speech) is explicitly out
  of scope for this deliverable.
- **Languages: ASL and GhSL.** BSL is deliberately excluded — no public BSL keypoint dataset
  exists, so offering it would show a Deaf user an avatar standing still. Blocked on both the
  frontend and the backend so the two cannot drift.
- **Region:** eu-west-1 (Ireland), chosen for latency from Ghana.
- **Hard constraint:** no AI runs on the client. Heavy work is offloaded to the cloud so
  low-spec laptops are never excluded.
- **Academic context:** KNUST final-year project. Supervisor documents live in
  `docs/supervisor/` (SRS, Software Design Document, Test Plan, Progress Report).

### Scope history worth knowing

The project **started as something else**. The original objective was a *bidirectional*
GhSL ↔ speech translator for a **video-conferencing app** (a Tauri desktop app, "Kasa"), with
MediaPipe Holistic pose capture, a Go/Rust/Python split backend, and a 1.5-year timeline for
2–50 concurrent users per call.

It was later **narrowed to the one-way browser extension** that exists now. If you find
documents or directories referencing video conferencing, multi-user calls, sign→text, or the
Kasa desktop app, they are **from the superseded scope**. The current deliverable is the
extension only.

---

## 2. Architecture

```text
tab audio (chrome.tabCapture)
    │  16 kHz mono PCM, 250 ms contiguous frames
    ▼
offscreen document ──WebSocket──► API Gateway
    │                                 │
    │                                 ▼
    │                            ws-audio-ingest → asr (Moonshine ONNX)
    │                                 │
    │                                 ▼
    │                            text-to-gloss  ("thank you" → THANK-YOU → asl-thank-you-v1)
    │                                 │
    │◄───────── signId ───────────────┘
    ▼
service worker ──relay──► content script
                              │  fetch <cdn>/asl/asl-thank-you-v1.json
                              ▼
                        Three.js avatar plays the keypoint clip
```

### Full lookup chain (this trips people up)

```text
spoken "hello"
  → backend/functions/text-to-gloss/dictionaries/{asl,ghsl}.json   (English → gloss)
  → gloss  HELLO
  → mapper.py to_sign_id()                                          (gloss → sign id)
  → sign id  asl-hello-v1
  → dictionary/asl/hello-v1.json                                    (sign id → keypoint clip)
  → extension/src/content/avatar.ts                                 (clip → avatar motion)
```

Two different "dictionaries" exist and are constantly confused:
`backend/functions/text-to-gloss/dictionaries/` is **word→label**;
`dictionary/` is **label→motion**.

### URL shape gotcha (looks like a bug, is not)

The client requests `/<lang>/<sign-id>.json` → `/asl/asl-hello-v1.json`, but on disk the file
is `asl/hello-v1.json` (the folder already supplies the language). This is reconciled
deliberately in two places: an nginx `alias` rewrite in `dev/dictionary/nginx.conf` for local
dev, and `upload-dictionary.py` naming S3 objects from each clip's own `signId` in production.
**Do not "fix" this.**

### Tech stack

| Layer | Choice |
| --- | --- |
| Extension | TypeScript, Vite, React (popup), Three.js (avatar) |
| ASR | **Moonshine ONNX** (MIT, fast on CPU). Replaced Whisper outright. |
| Text→gloss | Rule-based Python, deterministic — no inference |
| Gloss→sign | Static dictionary lookup of pre-generated clips (no GPU) |
| Cloud | AWS serverless — API Gateway WebSocket, Lambda, DynamoDB, S3 + CloudFront |
| IaC | Terraform (`backend/infrastructure/stacks`) |
| Local dev | Docker Compose (`dev/docker-compose.yml`) |

ASR history: Whisper → considered Parakeet TDT (rejected, needs paid GPU) → **Moonshine**.
An attempt to fine-tune Moonshine on **AfriSpeech-200** (Ghanaian accents) in Google Colab
**failed and was abandoned**; the stock `moonshine/base` model is what runs. (Reconstructed
from the prior session — the *decision* is clear from the transcript, the current state was
confirmed by `dev/docker-compose.yml` defaulting `ASR_MODEL: moonshine`.)

### Caption fast-path

For pre-recorded video **with a caption track**, the extension skips ASR entirely: it reads
cue text and sends `MAP_TEXT` with the cue's `startTime`. The backend echoes that time back on
each sign id, so signs are **scheduled** for the exact moment the words are spoken rather than
trailing. Live streams and caption-less video fall back to ASR. See
`startCaptionFeed()` in `extension/src/content/content.ts`.

---

## 3. Current state — what works

Verified this session unless noted.

- **Audio capture → transcript.** Working and near real-time (confirmed in the prior session
  against a live Apple video in Chrome).
- **Transcript → gloss → sign id.** Working.
- **Clip delivery.** Working.
- **Clip data integrity — all 3,179 clips validated:**
  - 67-joint OpenPose layout (BODY_25 + 21 left hand + 21 right hand), matching the rig map.
  - Shoulder width 0.393 (spec 0.4); neck at origin; +x = subject's left; +y = up; z always 0
    (2D source).
  - Every clip's frames start at `t=0` and end within `durationMs`. **Zero malformed.**
- **Gloss→clip coverage is complete:** ASL 1,981/1,981, GhSL 1,158/1,158. **Zero missing.**
  There is no 404 path in normal operation.
- **Avatar signing.** Working **as of this session** — see §4. Verified by driving the real
  retargeter with real clips: 188/188 sampled clips produce visible motion on all three rigs;
  one-handed signs move only the dominant wrist, two-handed signs move both.
- **Avatar framing.** Head-to-waist crop, legs cropped, hands in frame.

The `.orig` files sitting beside every clip are **pre-trim backups** (e.g. 78 frames → 37),
not corruption. `pose-generator/src/trim_clips.py` removed the dead air at the head and tail of
each recording.

---

## 4. What was fixed in the 2026-08-12 avatar session

The user reported two symptoms: *(a)* the avatar showed the whole body / top of the head
instead of a framed upper body, and *(b)* the avatar never signed and stood with its arms out.

**Both had a single root cause: a bone-name mismatch.**

`extension/src/content/rigs.ts` maps MakeHuman names like `upperarm01.L`, but the exported
GLBs name that bone `upperarm01L` — the separator is dropped somewhere on the
FBX → Blender → glTF route. Measured: **46 of 47 mapped bones failed to resolve.** Only
`neck01` matched, because it is the one name with no side suffix.

That failed in two places at once:

1. `Retargeter.build()` resolved 1 bone, so only the neck was ever driven — the arms and
   hands stayed in the **bind pose (T-pose)**. That was "not signing".
2. `Retargeter.calibrate()` looked up `upperarm01.L`, failed, and left `calibrated = false`.
   `getAxes()` then returned null, `frameCamera()` hit its first guard and returned, and the
   camera never moved off the constructor default `(0, 1.5, 4.4)` — a full-body wide shot.
   That was "legs / top of the head".

The framing formula was never the problem. **It simply never ran.**

### Fixes applied

| Fix | File | What |
| --- | --- | --- |
| `boneKey()` name normalisation | `rigs.ts`, `retarget.ts`, `avatar.ts` | Compares bone names with `[._\s]` stripped and lowercased, so both export conventions resolve. Verified collision-free across all 126 bones of all three rigs. |
| `spine01` → `spine05` | `retarget.ts` `calibrate()`, `avatar.ts` `orientUpright()` | MakeHuman numbers the spine **downwards**: `spine01` is the upper chest (z=1.192), `spine05` the pelvis (z=0.861). Measuring "up" from `spine01` spanned a few cm of forward-leaning chest and put the up-axis **17° off vertical**. Now 1.0–2.6°. This bug was invisible while calibration never ran. |
| Camera reframe | `avatar.ts` | Split measuring (`frameCamera`) from placing (`applyFraming`). Solves width and height separately against the real aspect ratio, and anchors the **bottom edge at the waist** so slack becomes headroom, not thighs. Now re-applied on `resize()`, which it previously was not. |
| Natural rest pose | `rigs.ts` `restFrame()` | Was dead-straight arms with fingers at the floor. Now a hand frame derived from the arm: ~68° elbow bend, forearms up/inward/forward, hands loosely in front of the body; finger curl 15°/30°/20° at MCP/PIP/DIP; thumb on the forward edge, barely bent so the hand does not read as a fist. |
| **Undriven intermediate bones (`gap`)** | `retarget.ts` `build()` / `apply()` | See below — this is the one that made the hands look wrung out. |

### The `gap` bug — twisted hands (found on visual inspection, 2026-08-13)

With signing working, a screenshot showed the framing correct but **the hands visibly
mangled**: fingers splayed, wrists rolled outward. The cause was structural, in `retarget.ts`.

The solver walks bones parent-before-child and composes each bone's world rotation from its
**nearest driven ancestor**. But MakeHuman interleaves bones the rig map does *not* drive
between ones it does:

```text
clavicleL (driven) → shoulder01L (UNDRIVEN, 38.5° rest rotation)
  → upperarm01L (driven) → upperarm02L (UNDRIVEN, 5.9°, twist pair)
    → lowerarm01L (driven) → lowerarm02L (UNDRIVEN, 0°)
      → wristL (driven) → metacarpals → fingers
```

`build()` computed the accumulated rest rotation of those skipped bones **only when the bone
had no driven ancestor at all** (`if (parent < 0)`) — precisely the case where there are none
to skip. Whenever there *was* a driven ancestor, the intermediate bones were silently dropped
and their rotation treated as identity. The code comment claimed they were "folded in below";
they never were.

Measured effect: `upperarm01` solved **38.1° off** its target direction — matching
`shoulder01`'s 38.5° rest rotation almost exactly. Because the error compounds down the chain,
the wrist and every finger inherited all of it, which is what wrung the hands out regardless of
what the rest pose said.

The fix computes the gap product for **every** driven bone (walking up and stopping at the
driven ancestor, or at the scene root when there is none — so the old case is subsumed) and
multiplies it into `parentWorld`.

**Verification.** Solve error, comparing each bone's achieved world direction against the
direction the clip asked for:

| Measurement | before | after |
| --- | --- | --- |
| rest pose, all 44 links | mean 21.4°, max 38.1° | **mean 0.00°, max 0.00°** |
| real clips, unclamped links (arms, wrist, metacarpals, neck), n=41,128 | — | **mean 0.000°, max 0.0°** |
| real clips, clamped finger joints, n=57,613 | — | mean 2.21°, max 70° |

The residual on finger joints is **the anatomical `limit: 110` clamp working as designed** —
rejecting bends no finger makes, caused by tracker noise in 2D source data. Every unclamped
bone is now exact.

### Framing constants are measured, not guessed

An initial guess of `SIGNING_WIDTH = 1.8` was too tight — once signing actually worked, **31%
of ASL frames** put a fingertip outside the frame, which looks identical to not signing. It was
replaced with a measurement over **81,492 hand-joint samples** (every wrist, middle fingertip
and thumb tip across a 1-in-11 sample of all 3,179 clips):

```text
lateral from midline   p95 0.316   p99 0.384   max 0.651   (shoulder span 0.365)
height above waist     p95 0.585   p99 0.630   (crown at 0.819)
depth below waist      p5 -0.073   p1 -0.166   min -0.249
```

Final: `SIGNING_WIDTH = 2.2`, `WAIST_MARGIN = 0.12` → **98.6–98.9% of actively-tracked joints
stay in frame**, top clipping 0.00%, bottom edge ~0.098 below the waist so trousers stay out.

Two judgement calls, both deliberate:

- Clipping is scoped to joints the clip **actually tracks**. Two thirds of residual clipping is
  the *idle* hand of a one-handed sign hanging at the signer's side — no linguistic content,
  not worth panning down for. The rigs are full-body (`male_casualsuit05Mesh` has trousers), so
  every extra centimetre below the hips is thigh in shot on every sign.
- The remaining ~1% are outliers near the 0.651 maximum, roughly a third beyond p99 — tracker
  noise in 2D source data rather than real reach. Chasing them would zoom out for every sign.

**Tuning dial:** if a wide sign ever clips, raise `SIGNING_WIDTH` in `avatar.ts`. 2.3 halves
the side clipping at the cost of ~5% more zoom-out.

### Popup redesign + Status page (2026-08-14)

The popup was 400px wide with settings as one eight-section scroll. It is now **800×600 —
Chrome's hard ceiling for a popup**, not a preference: a larger popup is silently clipped.

- **Onboarding** split from 4 steps into 6, one decision each. Permission previously also
  carried the audio-output choice; Placement previously carried corner, size *and* contrast.
- **Settings** is now a sidebar of eight short pages (Audio, Sign language, Signer, Placement,
  Look, Playback, Status, Privacy) instead of one column. Only the page scrolls.
- **New Status page** — a live readout of all eight pipeline stages, in the order audio flows
  through them, so the first stage showing nothing is the one at fault. Plumbed as
  `GET_DIAGNOSTICS` (popup → service worker → content script → `Avatar.getStatus()`), polled
  once a second while the page is open, and computed on demand so it costs nothing when closed.

The Status page exists because a silent avatar has at least six indistinguishable causes
(capture never started, socket down, no words matched, clip 404, model failed, rig map matched
nothing) and all of them render an identical blank rectangle. Stage 7 reports
`bonesDriven / bonesMissing` specifically because that was 1/46 for a long time with nothing
anywhere saying so.

---

## 5. Known problems and open work

### Confirmed gaps (measured this session)

1. **GhSL fingerspelling is completely absent — 0/26 alphabet clips.** Any word with no GhSL
   sign cannot be fingerspelled; it is simply skipped. This is the single largest functional
   hole for the primary target language.
2. **ASL fingerspelling is incomplete — 20/26.** Missing: **a, c, l, x, y, z**.
   `backend/functions/text-to-gloss/fingerspell.py` will emit sign ids for these letters that
   have no clip behind them.
3. **40 GhSL clips are unreachable.** 1,198 clip files exist but only 1,158 glosses are
   referenced by `ghsl.json`. Those 40 signs can never be emitted — they need English→gloss
   entries added.
4. **Vocabulary ceiling.** ASL ~1,985 English phrases, GhSL ~1,232. Ordinary speech will
   routinely contain words with no sign. Current behaviour is to skip them
   (`playPlaceholder()` → rest pose, i.e. the avatar just stands still). This is honest but
   means coverage, not correctness, is now the limiting factor on output quality.

### Risks / things to watch

- **`playPlaceholder()` is indistinguishable from a bug.** It deliberately renders the rest
  pose (an invented gesture on a human avatar would read as a real sign and mislead). But to
  anyone testing, "no clip for this word" and "the avatar is broken" look identical. When
  diagnosing, always check `docker compose logs` stage `4 CLIP` for 404s first.
- **The prior session's Colab fine-tune of Moonshine on AfriSpeech-200 failed** and was
  abandoned mid-way after repeated dataset/script errors. Ghanaian-accent ASR accuracy is
  therefore stock-model quality. Revisiting this is open work. (Reconstructed.)
- **Version control, as of 2026-08-15.** The repo is now git-tracked and pushed to
  https://github.com/Auel44/SignStream. Two things to know about its shape: the 3,180
  keypoint clips in `dictionary/` are committed deliberately (the datasets they were
  extracted from no longer exist, so these are the only copy), which makes the repo ~330MB
  and the first clone slow; and `extension/.env.local` is committed on purpose because a
  build without it resolves no dictionary URL and the avatar silently never signs. Every
  other `.env*` is ignored so a real endpoint added later is not published by accident.
- **Bone-name fragility.** `boneKey()` now absorbs separator differences, but a genuinely
  different skeleton (Mixamo's `mixamorig:LeftHandIndex1`) still needs a new `links` function in
  `rigs.ts`. `Retargeter.missingBones` logs a warning — **do not ignore it**; that warning was
  firing for 46 bones and nobody noticed.

### Explicitly out of scope

Sign → text → speech. Video conferencing. Multi-user calls. BSL.

### State of `data/` — do not assume anything is there

Measured this session:

- **`data/models/` is 68 KB and contains no model weights at all** — only READMEs plus the
  AfriSpeech fine-tuning scripts (`download_afrispeech.py`, `finetune_afrispeech.py`,
  `export_to_onnx.py`) that were used in the abandoned Colab attempt. Moonshine runs **inside
  the Docker image**, pulled at build time. Nothing in `data/models/` is loaded at runtime. Any
  document or README implying the model stack is "installed here" is stale.
- **`data/datasets/` is 22 GB and holds exactly one thing: `healthcare/SignTalk-GH/`.** This is
  the KNUST Responsible AI Lab GhSL healthcare dataset — ~10,000 **sentence-level videos with
  no keypoints**, plus an Excel metadata file mapping sentence ids to sentences. It has **never
  been converted** into `dictionary/` clips; doing so needs pose extraction from raw video
  (`pose-generator/src/extract_keypoints.py`), which is a substantially bigger job than the
  OpenPose-keypoint path already used for the word dictionary. It is also the single largest
  disk cost in the project.
- **`data/datasets/README.md` is stale.** It documents `afrispeech-200/`, `sign-videos/` and
  `general/` — all of which have been deleted. `general/GSL_openpose_data` was the source of the
  GhSL word dictionary and was removed after its keypoints were extracted into `dictionary/`.
  `data/processed/` and `data/raw/` are empty.

---

## 6. Avatar production pipeline (in-repo)

The avatars were **produced**, not downloaded, and the whole pipeline now lives in the repo:

- `MMS-Player/` — DFKI's open-source sign-language avatar animation system, **GPL-3.0**,
  Python scripts driven through Blender. Vendored third-party code, not SignStream's:
  see [MMS-Player/VENDORED.md](MMS-Player/VENDORED.md) for the upstream commit, the licence
  position, and the one local modification (asset paths anchored to `__file__`, because
  Blender resolves relative paths against the open `.blend` and `--background` has none).
  Nothing here runs at extension runtime. A working clone with the upstream remote still
  sits at `C:\Users\asant\Desktop\personal\MMS-Player` for pulling updates.
- `mms-out/` — FBX exports and their `textures/`. This is now the working output directory:
  **point new Blender exports here**, not at the old `personal\mms-out`.
- Blender is installed at `C:\blender-lts\blender-4.2.23-windows-x64\`; the AVASAG corpus
  at `C:\avasag-corpus\`.

### The four shipped rigs

`extension/public/` holds `avatar-m1`, `avatar-m2`, `avatar-f1`, `avatar-f2` `.glb`, built
from the `newavatar*.fbx` files in `mms-out/` by the Blender converter. All four share
MakeHuman's "Default simplified" skeleton — 137 bones — so they reuse one rig map, and each
was verified before landing: **47/47 mapped bones resolve, 0 missing, rest pose solves to
0.00 degrees, up-axis tilt 0.0 degrees**, one-handed clips move only the dominant wrist.

Two export rules, both load-bearing:

- **No Draco compression.** DRACOLoader decodes in a Web Worker built from a `blob:` URL, and
  host-page CSP (YouTube's included) blocks that — the model then fails silently.
- **PNG textures, not WebP.** WebP is ~30% smaller and was tried, but it writes
  `EXT_texture_webp` into `extensionsRequired`, so a loader that cannot negotiate it fails
  outright rather than degrading. It also cannot be verified headlessly without stubbing the
  support check to say yes. Textures are deduplicated (the FBX importer creates three copies
  of each) and downscaled instead — 1024 for skin, 512 general, 256 for normals — which
  brought the models from 23-33 MB each down to ~6 MB.

---

## 7. File map

```text
Asr-signing/
├── IMPLEMENTATION_PLAN.md          build-order plan derived from the proposal
├── SUMMARY.md                      this file
├── docs/supervisor/                SRS, Design Doc, Test Plan, Progress Report
├── backend/
│   ├── functions/
│   │   ├── asr/                    Moonshine streaming transcription
│   │   ├── text-to-gloss/          mapper.py, normaliser.py, fingerspell.py,
│   │   │   └── dictionaries/       asl.json (1,985) · ghsl.json (1,232) · bsl.json (3, locked)
│   │   ├── ws-connect / ws-disconnect / ws-audio-ingest
│   │   └── health-warmer/          keeps Lambdas warm
│   ├── infrastructure/stacks/      Terraform
│   ├── layers/ queues/ scripts/
├── dictionary/                     KEYPOINT CLIPS — asl/ (1,981) ghsl/ (1,198) bsl/ (1)
├── pose-generator/src/             openpose_to_dictionary.py, wlasl_to_dictionary.py,
│                                   trim_clips.py, build_gloss_vocabulary.py, audit_alphabet.py
├── dev/                            docker-compose.yml, gateway/, dictionary/nginx.conf,
│                                   e2e-check.py
├── MMS-Player/                     VENDORED third-party (GPL-3.0) — avatar authoring
│                                   tool, see VENDORED.md. Not runtime code.
├── mms-out/                        FBX exports + textures/ that the .glb rigs are
│                                   built from. New Blender exports go here.
└── extension/
    ├── manifest.json               MV3
    ├── .env.local                  points at the local dev stack
    ├── public/                     avatar.glb, avatar-man.glb, avatar-woman.glb
    └── src/
        ├── background/service-worker.ts   message router (only context that can reach content)
        ├── offscreen/                     audio capture + WebSocket owner
        ├── popup/                         React settings/onboarding UI
        ├── shared/config.ts types.ts      endpoints + the whole message contract
        └── content/
            ├── content.ts          orchestrator; caption-vs-ASR routing
            ├── avatar.ts           Three.js scene, camera framing, sign queue, playback
            ├── retarget.ts         clip keypoint POSITIONS → bone ROTATIONS
            ├── rigs.ts             bone maps, restFrame(), boneKey()
            ├── sign-clips.ts       fetch + LRU cache (bounded by frames, not entries)
            ├── captions.ts         reads the page's caption track
            ├── overlay.ts          draggable/resizable on-page overlay
            └── video-sync.ts       follows play/pause/seek/rate/fullscreen
```

---

## 8. How to run

```bash
# 1. Backend + clip CDN
docker compose -f dev/docker-compose.yml up -d --build
python dev/e2e-check.py                      # verifies the whole path

# 2. Extension
cd extension && npm install && npm run build  # runs tsc --noEmit then vite build
# then chrome://extensions → Developer mode → Load unpacked → extension/dist
```

Watch all four pipeline stages in one pane:

```bash
docker compose -f dev/docker-compose.yml logs -f
#  1 AUDIO  frame #17  8000 bytes  250.0ms  rms=0.104
#  2 ASR    FINAL 'the doctor said thank you'
#  3 GLOSS  thank you → THANK_YOU → ghsl-thank-you-v1
#  4 CLIP   200  /ghsl/ghsl-thank-you-v1.json  147002B
```

A `4 CLIP 404` is the **one** case where the avatar receives a sign it cannot play.

`ASR_MODEL=stub docker compose … up -d` drives the pipeline from canned sentences with no
model — fast for UI work. It defaults to real Moonshine on purpose: it used to default to
`stub`, and that silently looked like a working transcript that never matched the video.

Browser-side consoles: `chrome://extensions` → Details → Inspect views → **service worker**
(capture/frame logs), and the video page's own **DevTools console** (clip cache misses, avatar
errors, `[SignStream] rig … missing N mapped bones`).

---

## 9. Suggested next steps

1. `git init` in `Asr-signing/`. There is currently no history or undo.
2. **Re-check rendered output after the `gap` fix.** The first visual check (2026-08-13, live
   TV3 stream on YouTube) confirmed framing and signing but exposed the twisted hands — an
   error the analytical checks had missed entirely, because they only asked "do the bones
   move?", never "do they move to the *right* place". The direction-accuracy probe added while
   fixing it now closes that gap and should be the standard check. Rendered output still needs
   confirming once more.
3. Fill the fingerspelling gaps: ASL letters `a, c, l, x, y, z`, then GhSL a–z from scratch.
   `pose-generator/src/audit_alphabet.py` exists for this.
4. Add English→gloss entries for the 40 orphaned GhSL clips.
5. Grow the English→gloss dictionaries — vocabulary coverage is now the limiting factor.
6. Decide what to do with the 22 GB `SignTalk-GH` dataset: either convert it (sentence-level
   pose extraction from video) or archive it off the working disk. It is currently dead weight.
7. Refresh the stale `data/datasets/README.md` so it describes what is actually present.
