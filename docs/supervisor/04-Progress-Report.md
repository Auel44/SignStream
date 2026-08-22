# Progress Report

## SignStream: A Browser Extension for Real-Time One-Way Audio-to-Sign-Language Translation of Streaming Media

**Document Type:** Progress Report for Supervisor Inspection
**Reporting Period:** Project start to [Inspection Date]
**Version:** 0.1 (Draft for Supervisor Inspection)
**Author:** [Student Name], [Index Number]
**Programme:** [Programme of Study]
**Department:** [Department]
**Institution:** Kwame Nkrumah University of Science and Technology (KNUST)
**Supervisor:** [Supervisor Name]
**Date:** [Submission Date]

---

## Table of Contents

1. Summary
2. Work Completed
3. Work in Progress
4. Work Not Yet Started
5. Architectural and Scope Decisions
6. Metrics
7. Issues, Risks, and Mitigations
8. Supervisor Inputs Requested
9. Next Reporting Period Plan
10. Appendix: Evidence Index

---

## 1. Summary

The project is on schedule. The browser extension half of the system is functionally complete end to end on the client: tab audio is captured, downsampled, framed, streamed over a WebSocket, and an on-page Three.js avatar overlay is mounted, synced to the host video clock, and capable of playing placeholder gestures driven by incoming sign identifiers. The client also displays the live transcript caption alongside the avatar. The cloud backend has been architected and skeletoned: the directory layout, fault-isolation design, and per-Lambda responsibilities are documented and the AWS region and service set are fixed (eu-west-1, free-tier-compatible serverless). The next reporting period will turn the backend skeleton into a deployed pipeline (ASR plus text-to-gloss) and produce the first end-to-end demonstration on a real streaming video.

Documentation for supervisor inspection is in place: the proposal, the implementation plan, this progress report, and three supporting documents (the System Requirements Specification, Software Design Document, and Test Plan) are all submitted as part of this inspection package.

---

## 2. Work Completed

### 2.1 Project Foundation

- Repository initialised; directory layout established.
- AWS region selected (eu-west-1) and account configured with billing alarm thresholds in place from initial setup.
- Project documents drafted: proposal (PROPOSAL.md), implementation plan (IMPLEMENTATION_PLAN.md), and the four supervisor-inspection documents under `docs/supervisor/`.

### 2.2 Browser Extension — Step 1 (Shell)

- Manifest V3 manifest authored requesting only `storage`, `activeTab`, `tabCapture`, and `offscreen` permissions.
- React 18 + TypeScript + Tailwind popup with five controls: Signing-Avatar toggle, Sign-Language dropdown, Avatar-Position select, Avatar-Size select, Show-Live-Transcript checkbox.
- Service worker functioning as the single source of truth for settings, with persistence to `chrome.storage.sync`.
- Default settings initialised on first install.

### 2.3 Browser Extension — Step 2 (Capture)

- Offscreen document created; tab MediaStream obtained via `chrome.tabCapture.getMediaStreamId` and `getUserMedia` with the Chromium tab-source constraints.
- Audio passthrough to the user's speakers verified — captured audio does not silence the original video.
- Linear-interpolation downsampler to 16 kHz mono PCM implemented.
- Contiguous (non-overlapping) 250 ms framing implemented with sample accumulator.
- Per-frame statistics (sequence, sample rate, samples, duration, RMS, sent flag) reported to the service worker and printed at debug level for verification.

### 2.4 Browser Extension — Step 3 (Cloud streaming, client side)

- WebSocket client in the offscreen document streams binary Int16 PCM frames to the configured endpoint.
- Reconnection logic with exponential backoff (1, 2, 4, 8 s, capped at 10 s).
- Capture continues regardless of socket health — frames are dropped, not buffered indefinitely.
- Inbound transcript and sign-ID JSON messages are parsed and forwarded to the service worker.
- Cloud connection state is reported to the popup, which displays "Connecting to cloud…" or "Cloud connected" with a corresponding indicator.

### 2.5 Browser Extension — Step 4 (Avatar overlay)

- Content script mounts a Shadow-DOM-isolated overlay container on the page when capture begins.
- Three.js scene initialised on a canvas inside the overlay; placeholder skeletal avatar renders at 24 fps.
- Avatar play / pause is synchronised to the host page's primary `<video>` element.
- Live transcript caption is displayed under the avatar when the corresponding preference is enabled.
- Settings changes (position, size, transcript toggle) propagate to the overlay live without re-capture.
- Overlay cleanly unmounts on capture stop, leaving no residual DOM nodes.

### 2.6 Backend Skeleton

- Directory layout established: `functions/{ws-connect, ws-disconnect, ws-audio-ingest, asr, text-to-gloss, health-warmer}/`, `layers/common/`, `events/`, `queues/`, `infrastructure/stacks/{api, async, storage, monitoring}/`, `scripts/`.
- Fault-isolation strategy designed and documented: separate WebSocket route Lambdas; SQS plus EventBridge between stages; dead-letter queues per queue; per-stack infrastructure deployment.
- Cost guardrails decided: no Elastic Load Balancer; no NAT Gateway; CloudWatch billing alarm baked into the `monitoring` stack from day one.

### 2.7 Dictionary Scaffolding

- `dictionary/asl/`, `dictionary/bsl/`, `dictionary/ghsl/` directories created.
- Sign-identifier scheme agreed: `<language>-<gloss>-<version>` (for example `asl-hello-v1`).
- Initial vocabulary lists drafted for ASL (50 most common signs) and a starting GhSL set (25 signs identified for review with local teachers).

### 2.8 Supervisor Documentation

- 01-System-Requirements-Specification.md (this submission).
- 02-Software-Design-Document.md (this submission).
- 03-Test-Plan.md (this submission).
- 04-Progress-Report.md (this document).

---

## 3. Work in Progress

| Item | Status | Expected Completion |
| --- | --- | --- |
| Backend Lambda `ws-connect`, `ws-disconnect`, `ws-audio-ingest` | Handlers being written in Python; IaC stack `api` being assembled | End of next reporting period |
| Backend Lambda `asr` (Parakeet TDT streaming) | Inference pipeline drafted; Lambda packaging in progress | End of next reporting period |
| Backend Lambda `text-to-gloss` | Normalisation rules drafted; dictionary lookup design fixed | End of next reporting period |
| ASL dictionary content (pose clips) | 12 of 50 signs captured and stored as JSON keypoint clips | End of next reporting period |
| Three.js avatar — real keypoint playback | Joints wired but driven by placeholder data; integration with dictionary lookup pending the cloud pipeline | End of next reporting period |

---

## 4. Work Not Yet Started

| Item | Reason | Planned Start |
| --- | --- | --- |
| Pose-generator stretch goal | Dependent on the core dictionary pipeline reaching stable end-to-end | Week 4 of the build phase |
| GhSL pose recording with local signers | Awaits booking a recording session and the agreement of a GhSL teacher | Week 3 of the build phase |
| Cross-browser polish on Firefox | Chrome is the primary target during functional development | Week 7 of the test schedule |
| User acceptance testing | Awaits an end-to-end demonstrable build | Week 8 of the test schedule |

---

## 5. Architectural and Scope Decisions

The following decisions have been taken since the proposal was submitted, in consultation with the supervisor.

### 5.1 Direction Restated

The system is **one-way (audio to sign)**. The reverse direction (sign to text or speech) has been explicitly removed from scope. This simplifies the cloud pipeline considerably and aligns the architecture with the realistic capabilities of current open-source models.

### 5.2 Free-Tier Constraint Adopted

All AWS services have been chosen to fit always-free monthly allowances at the small scale targeted by the project. Elastic Load Balancer and NAT Gateway are explicitly excluded because they are the most common sources of unexpected bills. This was a meaningful design constraint because it ruled out container-based options (ECS, EKS) and reinforced the choice of Lambda plus API Gateway throughout.

### 5.3 ASR Model Selection

**Moonshine (Useful Sensors, MIT-licensed) is the primary ASR choice.** It was selected over Whisper and Parakeet after a cost/latency analysis: the deployment target is the AWS free-tier Lambda CPU, and Moonshine is purpose-built for fast, low-latency inference on CPU (it processes only the audio it is given, unlike Whisper which pads and re-transcribes a 30 s window). Whisper was removed from the project. Parakeet TDT is retained on paper as a future GPU upgrade — its accuracy is higher, but it needs a paid GPU (~$440/month always-on) to run at its best, which breaks the free-tier constraint. For Ghanaian accents, a Moonshine model fine-tuned on the AfriSpeech-200 dataset is used. All variants are selected via the `ASR_MODEL` environment variable on the `asr` Lambda (`stub` / `moonshine` / `moonshine-african`).

### 5.4 Contiguous (Non-Overlapping) Frames

The implementation plan originally suggested 200 to 500 ms overlapping windows. After investigation, contiguous (non-overlapping) frames were chosen because streaming ASR models maintain internal state across frames; overlap would double-count audio and harm transcript quality. The current frame size is 250 ms.

### 5.5 Avatar Approach

The avatar is keypoint-driven and skeletal (Three.js), with sign data stored as pose-keypoint JSON in S3 fronted by CloudFront. This was preferred over storing pre-rendered video files because it supports speed-independent playback, smooth blending between consecutive signs, and re-skinning of the avatar style without changing the dictionary.

### 5.6 Sign-Identifier Scheme

Signs are identified by the scheme `<language>-<gloss>-<version>` (for example `asl-hello-v1`). Versioning allows incremental improvements to a sign's pose clip without breaking already-cached client copies.

---

## 6. Metrics

### 6.1 Build State

| Metric | Value |
| --- | --- |
| Extension TypeScript strict-mode compile | Clean (zero errors) |
| Extension Vite production build | Succeeds |
| Manifest V3 schema validation | Passes |
| Backend skeleton stacks defined | 4 of 4 (api, async, storage, monitoring) |
| Backend Lambdas implemented | 0 of 6 |
| Sign dictionary entries (ASL) | 12 of 50 |
| Sign dictionary entries (BSL) | 0 of 25 |
| Sign dictionary entries (GhSL) | 0 of 25 |
| Supervisor inspection documents | 4 of 4 |

### 6.2 Approximate Code Volume

| Area | Lines of code |
| --- | --- |
| Extension `src/` (TypeScript + TSX) | ~700 |
| Backend `functions/` (Python) | Skeleton only |
| Infrastructure `stacks/` (IaC) | Skeleton only |
| Documentation (markdown) | ~3,000 |

### 6.3 Cost (To Date)

AWS billing for the reporting period is **0.00 USD**. No production resources have been deployed yet. The CloudWatch billing alarm is configured and armed.

---

## 7. Issues, Risks, and Mitigations

### 7.1 Active Issues

None blocking. One minor: the Chrome `@types/chrome` package version pinned in the extension does not include the promise overload for `chrome.tabCapture.getMediaStreamId`, so a callback-to-promise wrapper was added in the service worker. No functional impact.

### 7.2 Risks

| Risk | Probability | Impact | Mitigation |
| --- | --- | --- | --- |
| Lambda cold-start adds noticeable latency to first transcript | Medium | Medium | Health-warmer Lambda scheduled at 5-minute intervals; provisioned concurrency considered if the warmer is insufficient. |
| Open-source streaming ASR model is too large to package in a Lambda zip | Medium | Medium | Lambda container images (up to 10 GB) considered as a fallback packaging; alternatively, smaller models (Moonshine) are kept ready. |
| GhSL recording session is delayed by participant scheduling | Medium | Medium | Initial GhSL vocabulary started with synthesised approximations validated by online GhSL resources; real recordings will replace approximations as soon as available. |
| Streaming services with DRM (Netflix, Disney+) refuse `chrome.tabCapture` | High | Low | Documented limitation; demonstrations and user testing focus on accessible content sources (YouTube, podcasts, news sites, university lectures). |
| Backend cost exceeds the free tier during load testing | Low | Medium | CloudWatch billing alarm at 5 USD; load tests are time-boxed and run on weekends to keep monthly free-tier reset windows tight. |

---

## 8. Supervisor Inputs Requested

I would value the supervisor's confirmation on the following points before proceeding with the next reporting period:

1. **Scope confirmation.** Does the supervisor agree with the one-way-only scope and the deliberate exclusion of the sign-to-text reverse direction?
2. **Evaluation rigour.** Does the evaluation plan in the Test Plan (latency, concurrency, endurance, accessibility, user testing with at least four participants and at least two deaf participants) meet the department's expectations for the final-year project?
3. **Cost ceiling.** Is the 5 USD/month CloudWatch billing alarm threshold acceptable, or should it be set lower?
4. **Ethics committee.** Should ethics approval be applied for now, or once the first end-to-end demonstration is ready?
5. **Open-source licence for the trained gloss model and dictionary.** Is Apache 2.0 (model) plus Creative Commons BY-SA 4.0 (dictionary content) acceptable, or does the department prefer another arrangement?

---

## 9. Next Reporting Period Plan

| Week | Activity |
| --- | --- |
| 1 | Deploy `api` stack to staging; verify $connect, $disconnect, and audio-ingest end to end with the extension. |
| 1 | Implement `text-to-gloss` Lambda with normalisation and ASL dictionary lookup. |
| 2 | Implement `asr` Lambda with Parakeet TDT streaming; deploy to staging. |
| 2 | Complete ASL dictionary to 50 signs and upload pose clips to S3. |
| 3 | Connect the extension's avatar to real pose clips fetched by sign ID; integrate with the CloudFront cache. |
| 3 | Run first end-to-end smoke and latency tests on a YouTube video. |
| 4 | Document results; prepare for the next supervisor inspection. |

---

## 10. Appendix: Evidence Index

| Item | Location |
| --- | --- |
| Project proposal | `PROPOSAL.md` (parent project root) |
| Implementation plan | `IMPLEMENTATION_PLAN.md` |
| System Requirements Specification | `docs/supervisor/01-System-Requirements-Specification.md` |
| Software Design Document | `docs/supervisor/02-Software-Design-Document.md` |
| Test Plan | `docs/supervisor/03-Test-Plan.md` |
| Progress Report | `docs/supervisor/04-Progress-Report.md` (this document) |
| Extension manifest | `extension/manifest.json` |
| Extension shared types | `extension/src/shared/types.ts` |
| Service worker | `extension/src/background/service-worker.ts` |
| Offscreen capture and streaming | `extension/src/offscreen/offscreen.ts` |
| Content overlay | `extension/src/content/overlay.ts`, `avatar.ts`, `video-sync.ts` |
| Popup UI | `extension/src/popup/App.tsx` |
| Backend skeleton README | `backend/README.md` |

---

*End of Progress Report.*
