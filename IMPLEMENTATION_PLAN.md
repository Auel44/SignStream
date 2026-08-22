# SignStream — Implementation Plan

A practical, build-order plan derived from the project proposal. SignStream is a Manifest V3 browser
extension that performs **one-way** real-time translation of streaming-media audio into sign language
(ASL / BSL / GhSL) via an on-screen 3D avatar, backed by a free-tier serverless AWS pipeline.

- **Direction:** audio → sign only. The reverse path (sign → text/speech) is explicitly out of scope.
- **Core deliverable (Option A):** dictionary-based one-way pipeline (committed).
- **Stretch deliverable (Option B):** offline open-source pose generation (not required for completion).
- **Region:** eu-west-1 (Ireland), chosen for latency from Ghana.
- **Guiding constraint:** no AI runs on the client; heavy work is offloaded to the cloud so low-spec
  laptops are never excluded.

---

## 1. Architecture at a glance

**Client (browser extension)** — tied to the user's screen and timing:
tab-audio capture → chunked streaming → avatar rendering (Three.js) → video-clock sync → UI/preferences.

**Cloud (AWS, serverless)** — anything heavy or shared:
streaming ASR → text normalisation → gloss → sign-ID mapping → pose assets via S3 + CloudFront.

**End-to-end flow:**
spoken audio → extension captures & streams 200–500 ms overlapping chunks over a WebSocket →
streaming ASR returns text → server maps text to a sign ID → client fetches the keypoint clip from
CloudFront (or local cache) → Three.js plays it on the avatar → playback aligned to `video.currentTime`.

**Real-time strategy:** transcript leads (provisional output shown immediately); the avatar follows,
driven only by *finalised* words a fraction of a second behind, so it never signs a word that is later
corrected. Target end-to-end delay: sub-second to ~2 s.

See [backend/README.md](backend/README.md) for the loose-coupling / fault-isolation design.

---

## 2. Open-source model choices per stage

| Stage | Primary choice | Notes / alternatives |
|-------|----------------|----------------------|
| Audio capture | Browser `tabCapture` API (MV3) | Native; no model or server load |
| Speech-to-text | Moonshine ONNX (MIT, fast on CPU) — default; AfriSpeech-fine-tuned for Ghana | Parakeet TDT (higher accuracy, needs a paid GPU) |
| Text → gloss | Rule-based + lightweight open NLP | Negligible compute; deterministic across users |
| Gloss → sign (core) | Curated dictionary of pre-generated pose clips | Lookup, not inference — instant, no GPU |
| Gloss → sign (stretch) | sign-language-processing / Ham2Pose / SignLLM | Pre-generate continuous poses offline |
| Avatar rendering | Three.js (keypoint-driven skeletal avatar) | Runs locally, light enough for low-spec devices |

---

## 3. AWS services

| Service | Role | Free-tier fit |
|---------|------|---------------|
| API Gateway (WebSocket) | Receive audio chunks; push back text/sign IDs; manage connections | Always-free monthly message/connection allowance |
| Lambda | ASR inference + text-to-gloss per chunk; stateless | 1M always-free requests/month; auto-scales |
| S3 | Pose/keypoint assets + extension static files | Free-tier storage |
| CloudFront | Edge-cache pose assets near Accra | Always-free monthly data transfer |
| DynamoDB | Connections, sessions, preferences, dictionary metadata | 25 GB always-free, on-demand |
| Cognito | Optional lightweight auth | Free monthly active-user allowance |
| CloudWatch | Logs, metrics, billing alarms | Basic monitoring within free allowance |
| SQS + EventBridge | Decoupling between ingest → ASR → gloss (with DLQs) | Always-free message allowances |

Deliberately avoided: Elastic Load Balancer and NAT Gateway (not free-tier; common cause of surprise bills).

---

## 4. Build phases

The proposal frames this as a one-month project. Each week is a phase with a concrete, demoable milestone.

### Phase 0 — Foundations (before Week 1)
- [ ] Initialise repo, set up the workspace and `.gitignore`.
- [ ] AWS account + IAM with least-privilege roles; set region to eu-west-1.
- [ ] **Configure CloudWatch billing alarms from the outset** (cost guardrail).
- [ ] Scaffold IaC (`infrastructure/stacks/`): empty `api`, `async`, `storage`, `monitoring` stacks.
- [ ] Define event/message schemas (`events/`) and the SQS + DLQ definitions (`queues/`).

### Phase 1 — Week 1: Capture → cloud ASR
*Milestone: audio captured and transcribed in the cloud, text returned to the client.*
- [ ] Extension shell: MV3 manifest, React + Vite + Tailwind popup, service worker.
- [ ] Tab-audio capture via offscreen document; resample to 16 kHz mono PCM.
- [ ] Chunk audio into 200–500 ms overlapping windows; stream over WebSocket.
- [ ] `ws-connect` / `ws-disconnect`: connection lifecycle in DynamoDB.
- [ ] `ws-audio-ingest`: validate chunk, enqueue to SQS (no synchronous processing).
- [ ] `asr` Lambda: consume queue, run streaming ASR (Parakeet/Moonshine), publish transcript event.
- [ ] Push transcript text back to the client via API Gateway management API.

### Phase 2 — Week 2: End-to-end audio → sign (single language, ASL)
*Milestone: end-to-end audio→sign on a limited ASL vocabulary, synced to video.*
- [ ] `text-to-gloss` Lambda: normalise transcript → controlled gloss vocabulary → sign ID.
- [ ] Build the bounded ASL dictionary (a few hundred common words/phrases) → `dictionary/asl/`.
- [ ] Generate/curate pre-rendered keypoint pose clips; upload to S3; front with CloudFront.
- [ ] Content script: Three.js avatar overlay; fetch clip by sign ID (CloudFront + local cache).
- [ ] Video sync: drive playback against `video.currentTime`; transcript leads, avatar follows finals.

### Phase 3 — Week 3: Multilingual + concurrency
*Milestone: working multi-language prototype handling several simultaneous users.*
- [ ] Add BSL and GhSL dictionaries → `dictionary/bsl/`, `dictionary/ghsl/` (start GhSL small, validate locally).
- [ ] Language switching in the popup; per-session language stored in DynamoDB.
- [ ] Concurrency testing: multiple simultaneous WebSocket connections; verify Lambda/API-GW auto-scaling.
- [ ] `health-warmer`: scheduled keep-warm to mitigate Lambda cold starts during sessions.
- [ ] Verify DLQ behaviour and graceful degradation (transcript fallback if gloss/dictionary unavailable).

### Phase 4 — Week 4: Stretch + evaluation + documentation
*Milestone: evaluation results, final report, demonstration.*
- [ ] (Stretch) `pose-generator/`: offline pose generation for one narrow domain — run locally, never on paid compute.
- [ ] Run the evaluation plan (Section 5).
- [ ] Finalise documentation, limitations, and demo.

---

## 5. Evaluation plan

- **Recognition accuracy** — word error rate of the ASR stage on sample streaming audio.
- **Coverage** — proportion of recognised words mapped to a sign, per language.
- **Latency** — end-to-end delay audio→rendered sign, including the Accra↔Ireland round trip.
- **Concurrency** — behaviour and latency under multiple simultaneous users.
- **Cost** — confirm usage stays within AWS always-free allowances at the tested scale.
- **Usability** — qualitative feedback, ideally including Deaf or hard-of-hearing participants.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Text-to-sign is an open research problem | Core uses a bounded dictionary; generation is stretch-only |
| Network latency (Accra ↔ eu-west-1) | Light streaming model, small chunks, buffer behind video clock; test region early |
| Lambda cold starts | Keep functions warm during sessions; small packages; lightweight models |
| Exceeding free-tier allowances | CloudWatch billing alarms; offline pose generation; cap concurrency in testing |
| Limited GhSL data/animation | Start with a small, locally validated GhSL vocabulary; expand iteratively |
| Audio privacy | Process chunks transiently in Lambda; never persist audio |

---

## 7. Ethical positioning

SignStream is positioned strictly as an **assistive prototype and research contribution**. It does not
claim to replace qualified human interpreters, foregrounds its limitations rather than overstating
capability, and commits to involving Deaf user feedback where possible. This responds directly to the
Deaf community's concern that low-quality signing avatars can be worse than no provision and may be used
to avoid funding human interpreters.

---

## 8. Definition of done (core deliverable)

- A working MV3 extension performing the full one-way flow on low-spec devices.
- Language switching across ASL, BSL, and GhSL within one architecture.
- A serverless, free-tier deployment that handles concurrency/load automatically for a small user base.
- A modular architecture where each open-source component can be swapped independently.
- An honest written evaluation of what is feasible with current free models and free-tier infrastructure.
