# Software Design Document (SDD)

## SignStream: A Browser Extension for Real-Time One-Way Audio-to-Sign-Language Translation of Streaming Media

**Document Type:** Software Design Document
**Version:** 0.1 (Draft for Supervisor Inspection)
**Author:** [Student Name], [Index Number]
**Programme:** [Programme of Study]
**Department:** [Department]
**Institution:** Kwame Nkrumah University of Science and Technology (KNUST)
**Supervisor:** [Supervisor Name]
**Date:** [Submission Date]

---

## Table of Contents

1. Introduction
2. Architectural Design
3. Component Design
4. Data Design
5. Interface Design
6. Concurrency and Sequencing
7. Error Handling and Fault Isolation
8. Deployment Design
9. Security Design
10. Design Rationale and Trade-offs

---

## 1. Introduction

### 1.1 Purpose

This document describes the software design of SignStream. It complements the System Requirements Specification by showing how the requirements are realised in code: the components, the data they exchange, the interfaces between them, and the rationale for the chosen design.

### 1.2 Scope

The design covers two deployable parts:

1. The browser extension (Manifest V3, React, TypeScript, Vite, Three.js).
2. The serverless AWS backend (API Gateway WebSocket, Lambda, DynamoDB, SQS, EventBridge, S3, CloudFront, CloudWatch).

### 1.3 Design Principles

Four principles shape every design decision in the system:

- **Loose coupling.** Components communicate through messages, queues, or events, never through direct in-process calls between stages. A failing stage is isolated to its own queue and does not cascade through the rest of the pipeline.
- **Single responsibility.** Each module owns one concern. The service worker owns settings and orchestration. The offscreen document owns audio capture and the WebSocket. The content script owns rendering. Each backend Lambda owns one stage of the pipeline.
- **Client never does the heavy work.** No machine-learning inference runs in the browser. The client captures, frames, streams, and renders. All recognition and gloss mapping is in the cloud, so users on low-spec devices are never excluded.
- **Free-tier discipline.** The backend is designed end-to-end to fit AWS always-free monthly allowances. The Elastic Load Balancer and NAT Gateway are deliberately avoided because they are the most common sources of unexpected bills.

---

## 2. Architectural Design

### 2.1 System Context

```
   ┌─────────────────────────────┐
   │   Streaming media tab       │
   │   (YouTube, news, podcast)  │
   └──────────────┬──────────────┘
                  │ tab audio
                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │   Browser extension (Manifest V3)                            │
   │                                                              │
   │   Popup ─┐         ┌─ Offscreen document ─┐                 │
   │   (UI)   │         │  Capture, downsample,│                 │
   │          ▼         │  frame, WebSocket     │                 │
   │   Service worker ──┼──────────────────────┐                 │
   │   (settings,       │                       │                 │
   │    orchestrator)   ▼                       │                 │
   │                Content script ◄────────────┘                 │
   │                (overlay, avatar, video sync)                 │
   └──────────────────────┬───────────────────────────────────────┘
                          │ WebSocket (audio frames + JSON results)
                          ▼
   ┌─────────────────────────────────────────────────────────────┐
   │   AWS eu-west-1 (Ireland)                                    │
   │                                                              │
   │   API Gateway (WebSocket)                                    │
   │     │                                                        │
   │     ├── $connect    ──► ws-connect    ──► DynamoDB           │
   │     ├── $disconnect ──► ws-disconnect ──► DynamoDB           │
   │     └── default     ──► ws-audio-ingest ──► SQS              │
   │                                              │               │
   │                                              ▼               │
   │                                            asr (Lambda)      │
   │                                              │               │
   │                                              ▼ EventBridge   │
   │                                            text-to-gloss     │
   │                                              │               │
   │                                              ▼               │
   │                                       API Gateway mgmt API   │
   │                                              │               │
   │                                              ▼               │
   │                                       transcripts + sign IDs │
   │                                       (back to the client)   │
   │                                                              │
   │   S3 + CloudFront: pose / keypoint clips by sign ID          │
   └──────────────────────────────────────────────────────────────┘
```

### 2.2 Architectural Style

The system uses a **layered, event-driven, asynchronous pipeline**:

- The client is a small, layered application (UI, orchestrator, capture, renderer).
- The backend is an event-driven asynchronous pipeline (queue, event bus, stages).
- The two halves communicate over a single WebSocket connection per session.

### 2.3 Architectural Tactics

| Tactic | Where it is applied |
| --- | --- |
| **Asynchronous messaging** | Backend stages connected by SQS and EventBridge; client contexts connected by `chrome.runtime` messages. |
| **Bulkhead** | Each Lambda has its own queue or event subscription; failure in one does not deplete capacity in another. |
| **Circuit breaker** | The offscreen WebSocket reconnects with exponential backoff and gives up after the capture stops. |
| **Dead-letter queue** | SQS DLQs receive messages that fail repeatedly so the live pipeline is not blocked. |
| **Cache** | The content script caches pose clips by sign ID in memory; CloudFront caches at the edge. |
| **Graceful degradation** | If the gloss stage fails, the transcript caption is still displayed. If the cloud is unreachable, audio passthrough still works. |

---

## 3. Component Design

This section describes each component, its responsibilities, and its public interface.

### 3.1 Extension Components

#### 3.1.1 Popup UI (`src/popup/`)

| Aspect | Detail |
| --- | --- |
| Technology | React 18 with TypeScript, Tailwind CSS, Vite |
| Entry point | `popup/main.tsx` mounts `<App />` into `popup/index.html` |
| Responsibility | Render the user-facing controls (toggle, language, position, size, transcript). Reflect live capture and cloud state. |
| Owns | No persistent state; reads via `GET_SETTINGS`, writes via `SAVE_SETTINGS`. |
| Does not own | Any audio handling, any DOM modification of the host page, any direct WebSocket logic. |

#### 3.1.2 Service Worker (`src/background/service-worker.ts`)

| Aspect | Detail |
| --- | --- |
| Technology | Manifest V3 background service worker (ES module) |
| Responsibility | Single source of truth for settings. Orchestrates capture (popup request → tabCapture stream ID → offscreen document boot). Routes messages between popup, offscreen document, and content script (the only context with `tabs.sendMessage`). |
| Owns | `captureActive`, `captureTabId`. Settings persistence via `chrome.storage.sync`. |
| Does not own | Audio data; rendering; cloud WebSocket. |

#### 3.1.3 Offscreen Document (`src/offscreen/`)

| Aspect | Detail |
| --- | --- |
| Technology | `chrome.offscreen` document hosting Web Audio API + WebSocket |
| Responsibility | Open the captured tab MediaStream via `getUserMedia` with `chromeMediaSource: 'tab'`. Pass through to speakers for the user. Downsample to 16 kHz mono. Frame into contiguous 250 ms windows. Convert to Int16 PCM. Stream over the WebSocket. Reconnect with exponential backoff. Forward incoming JSON results to the service worker. |
| Owns | `AudioContext`, `MediaStream`, `ScriptProcessorNode`, `WebSocket`, sequence counter, pending sample buffer. |
| Does not own | Any UI; any cross-tab state. |

#### 3.1.4 Content Script (`src/content/`)

| Aspect | Detail |
| --- | --- |
| Technology | Plain TypeScript bundled by Vite, runs at `document_idle` on every page |
| Responsibility | Mount the avatar overlay in a Shadow DOM when capture begins on this tab. Render the avatar with Three.js. Sync the avatar's playback clock to the host page's primary `<video>` element. Render the live transcript caption. Tear down cleanly when capture stops. |
| Sub-modules | `content.ts` (entry, message dispatch), `overlay.ts` (Shadow-DOM container, layout, styling), `avatar.ts` (Three.js scene, sign playback queue), `video-sync.ts` (host video discovery, play/pause hooks). |
| Owns | The on-page DOM node it creates; the WebGL canvas; the playing sign queue. |

#### 3.1.5 Shared (`src/shared/`)

| Aspect | Detail |
| --- | --- |
| Files | `types.ts` (all message and settings types), `config.ts` (`WS_ENDPOINT`) |
| Responsibility | Contract between contexts. Every other context depends on `types.ts`, not on any other context's implementation. |

### 3.2 Backend Components

#### 3.2.1 ws-connect (`functions/ws-connect/`)

Handles the `$connect` route of the WebSocket API. Inserts a record into the `Connections` DynamoDB table with `{ connectionId, language, connectedAt, lastSeenAt }`. Returns `200 OK`. Failure does not affect other connections.

#### 3.2.2 ws-disconnect (`functions/ws-disconnect/`)

Handles `$disconnect`. Deletes the corresponding record from `Connections`. Idempotent.

#### 3.2.3 ws-audio-ingest (`functions/ws-audio-ingest/`)

Handles the default route. Validates that the incoming binary payload is a 250 ms Int16 PCM frame (size check, sequence number from metadata). Enqueues `{ connectionId, sequence, framePayload }` to the `audio-queue` SQS queue. Returns immediately. Never performs ASR synchronously.

#### 3.2.4 asr (`functions/asr/`)

SQS consumer. Reads one or more frames at a time, feeds them to the streaming ASR model (Moonshine ONNX by default — fast on CPU, MIT-licensed; an AfriSpeech-fine-tuned Moonshine for Ghanaian accents; and Parakeet TDT reserved as a GPU upgrade). Publishes a transcript event to EventBridge with `{ connectionId, text, isFinal, language }`. Pushes the same transcript back to the originating WebSocket via the API Gateway management API so the client sees live captions even while the gloss stage is still computing.

#### 3.2.5 text-to-gloss (`functions/text-to-gloss/`)

EventBridge consumer subscribing to transcript events. Normalises the text (lowercase, punctuation strip, contraction expansion). Maps each normalised token to a controlled gloss using rule-based logic plus a per-language dictionary. Looks up each gloss in the per-language sign-ID index. Pushes each sign identifier back to the originating connection via the API Gateway management API.

#### 3.2.6 health-warmer (`functions/health-warmer/`)

Scheduled (every 5 minutes) Lambda that invokes the ASR and text-to-gloss Lambdas with a sentinel payload to keep their containers warm. Mitigates cold-start latency during active sessions.

#### 3.2.7 Common Layer (`layers/common/`)

Shared utilities packaged as a Lambda layer: structured logger, DynamoDB client wrapper, API Gateway management client, message schemas (Pydantic-style typed dictionaries).

---

## 4. Data Design

### 4.1 In-Memory Structures (Client)

| Structure | Owner | Fields | Purpose |
| --- | --- | --- | --- |
| `ExtensionSettings` | `chrome.storage.sync` via service worker | `enabled`, `language`, `showTranscript`, `avatarPosition`, `avatarSize` | User preferences |
| `Capture` | Offscreen document | `stream`, `context`, `source`, `processor` | Active audio capture handles |
| `pending` | Offscreen document | `Float32Array` | Buffer of un-emitted samples waiting to complete a frame |
| `AudioChunkStats` | Service worker (read-only) | `seq`, `sampleRate`, `samples`, `durationMs`, `rms`, `sent` | Per-frame statistic for debugging and the optional meter |

### 4.2 DynamoDB Tables (Backend)

| Table | Partition Key | Sort Key | TTL | Purpose |
| --- | --- | --- | --- | --- |
| `Connections` | `connectionId` | (none) | 30 minutes after `lastSeenAt` | Live WebSocket connection metadata |
| `Preferences` | `userId` | (none) | (none) | Optional persisted preferences if Cognito is enabled |
| `DictionaryMeta` | `language` | `glossKey` | (none) | `glossKey` → S3 object key for the pose clip |

### 4.3 SQS Queues

| Queue | Visibility timeout | Retention | DLQ |
| --- | --- | --- | --- |
| `audio-queue` | 30 s | 4 hours | `audio-dlq` |
| `transcript-queue` | 30 s | 4 hours | `transcript-dlq` (if a transcript topic is used in lieu of EventBridge) |

### 4.4 EventBridge

A single custom event bus, `signstream-bus`, carries:

- `signstream.transcript` — `{ connectionId, language, text, isFinal, timestamp }`.
- `signstream.signId` — `{ connectionId, language, signId, timestamp }` (optional, used for backend-internal fan-out; the primary delivery path is direct push to the WebSocket).

### 4.5 S3 / CloudFront

S3 bucket `signstream-poses-eu-west-1` holds one JSON keypoint clip per sign, organised as `poses/<language>/<sign-id>.json` (for example `poses/asl/asl-hello-v1.json`). CloudFront distribution fronts the bucket with the default cache behaviour set to one day. The same client cache key is used for in-memory caching in the content script.

---

## 5. Interface Design

### 5.1 Extension Internal Messages

The complete message union is defined in [extension/src/shared/types.ts](../../extension/src/shared/types.ts). The diagram below shows the direction of each message:

```
   ┌────────┐                 ┌──────────────────┐                 ┌────────────┐
   │ Popup  │                 │ Service worker   │                 │ Offscreen  │
   │ React  │                 │ (orchestrator)   │                 │ Web Audio  │
   └───┬────┘                 └────┬─────────────┘                 └──────┬─────┘
       │ GET_SETTINGS              │                                       │
       │ SAVE_SETTINGS             │                                       │
       │ START_CAPTURE             │                                       │
       │ STOP_CAPTURE              │                                       │
       ├──────────────────────────►│                                       │
       │                           │ OFFSCREEN_START                       │
       │                           │ OFFSCREEN_STOP                        │
       │                           │ OFFSCREEN_SET_LANGUAGE                │
       │                           ├──────────────────────────────────────►│
       │                           │              AUDIO_CHUNK              │
       │                           │              CLOUD_STATUS             │
       │                           │              TRANSCRIPT               │
       │                           │              SIGN_ID                  │
       │                           │◄──────────────────────────────────────┤
       │ CAPTURE_STATE             │                                       │
       │ SETTINGS                  │                                       │
       │ TRANSCRIPT                │                                       │
       │◄──────────────────────────┤                                       │
       │                           │ relay TRANSCRIPT, SIGN_ID,            │
       │                           │ CAPTURE_STATE, SETTINGS               │
       │                           ├──────────────────────────────────────►│ Content script
```

### 5.2 Cloud Wire Protocol

Defined in `types.ts` as `ClientControlMessage` and `CloudResponse`.

**Client to cloud:**

- Binary frames: raw Int16 little-endian PCM at 16 kHz mono, 250 ms each.
- Text frames (JSON): `{ "action": "setLanguage", "language": "ASL" | "BSL" | "GhSL" }`.

**Cloud to client (JSON):**

- `{ "type": "ready" }` — handshake complete.
- `{ "type": "transcript", "text": "...", "isFinal": false }` — incremental transcript.
- `{ "type": "signId", "id": "asl-hello-v1" }` — one sign to play.
- `{ "type": "error", "message": "..." }` — recoverable error.

### 5.3 Backend Internal Contracts

| Stage | Inbound | Outbound |
| --- | --- | --- |
| `ws-connect` | API Gateway `$connect` event | `Connections` table put |
| `ws-disconnect` | API Gateway `$disconnect` event | `Connections` table delete |
| `ws-audio-ingest` | API Gateway default event (binary body) | SQS `audio-queue` message |
| `asr` | SQS `audio-queue` records | EventBridge `signstream.transcript`; API GW mgmt push back |
| `text-to-gloss` | EventBridge `signstream.transcript` | API GW mgmt push back (`signId`) |

---

## 6. Concurrency and Sequencing

### 6.1 Sequence Diagram — Enabling Signing

```
Popup            Service Worker         tabCapture         Offscreen Doc        WebSocket
  │  toggleEnabled                            │                  │                  │
  ├──START_CAPTURE────►                       │                  │                  │
  │                  ├─getMediaStreamId──────►│                  │                  │
  │                  │                  ◄────── streamId          │                  │
  │                  ├─ensureOffscreenDocument─────────────────►│                  │
  │                  ├─OFFSCREEN_START (streamId, lang, ws)────►│                  │
  │                  │                                          ├─getUserMedia────►│ (Web Audio)
  │                  │                                          ├─new WebSocket───►│
  │                  │                                          │                  │  open
  │                  │                                          │◄──── ready ──────┤
  │  ◄──CAPTURE_STATE active=true────────────                    │                  │
  │                                                              │ audio frames ──►│
  │                                                              │◄── transcript ──┤
  │  ◄──TRANSCRIPT────────────────────────                        │                  │
```

### 6.2 Sequence Diagram — Cloud Pipeline

```
Client           API Gateway       ws-audio-ingest      SQS         asr Lambda    EventBridge   text-to-gloss   API GW Mgmt
  │ binary frame    │                    │              │              │              │              │              │
  ├────────────────►│                    │              │              │              │              │              │
  │                 ├───invoke──────────►│              │              │              │              │              │
  │                 │                    ├──SendMessage►│              │              │              │              │
  │                 │◄───200─────────────┤              │              │              │              │              │
  │                 │                    │              ├──pollMessage►│              │              │              │
  │                 │                    │              │              ├──ASR infer   │              │              │
  │                 │                    │              │              ├─PutEvents───►│              │              │
  │                 │                    │              │              ├──PostToConn──┼──────────────┼─────────────►│ (transcript)
  │  ◄── transcript ─────────────────────────────────────────────────────────────────────────────────────────────────┤
  │                 │                    │              │              │              ├──invoke─────►│              │
  │                 │                    │              │              │              │              ├──lookup gloss│
  │                 │                    │              │              │              │              ├──PostToConn ►│ (signId)
  │  ◄── signId ───────────────────────────────────────────────────────────────────────────────────────────────────┤
```

### 6.3 Threading and Async Notes

- All Lambdas are stateless and concurrency-safe by default. Each invocation handles one batch of messages.
- The offscreen document uses an `AudioContext` callback (`onaudioprocess`) running on the audio thread. Frames are emitted synchronously into the WebSocket; non-blocking.
- The service worker can be terminated by Chrome at any time when idle. All persistent state is in `chrome.storage.sync`, and capture state is reconstructed from the offscreen document on resume.

---

## 7. Error Handling and Fault Isolation

### 7.1 Client

| Failure | Behaviour |
| --- | --- |
| User declines or browser cancels `getMediaStreamId` | Service worker broadcasts `CAPTURE_STATE { active:false, error: <msg> }`. Popup displays the error. No retry; user must re-toggle. |
| WebSocket closes mid-session | Offscreen schedules reconnect with exponential backoff (1, 2, 4, 8 s, cap 10 s). Capture continues; frames are dropped while disconnected. |
| Host page has no video element | Avatar plays without sync to a video clock; transcript caption still works. |
| Content script cannot mount overlay | Service-worker relay is best-effort and swallows the error. Popup remains usable. |

### 7.2 Backend

| Failure | Behaviour |
| --- | --- |
| `ws-audio-ingest` throws | API Gateway returns 5xx to the client. Frame is dropped. No state stored. Retry happens on the next frame. |
| SQS message poison-pill | After three retries the message lands in `audio-dlq`. Live pipeline continues. |
| ASR model timeout | Lambda returns failure; message is re-driven by SQS visibility timeout. After redrives, the message lands in `audio-dlq`. |
| EventBridge target failure | EventBridge retries internally; on exhaustion the event is sent to the EventBridge DLQ. |
| API Gateway mgmt push fails (stale connection) | Lambda removes the stale connection from DynamoDB. The remaining pipeline continues for other connections. |

---

## 8. Deployment Design

### 8.1 Extension

| Step | Tool |
| --- | --- |
| Type-check | `tsc --noEmit` |
| Build | `vite build` → `dist/` |
| Pack | `web-ext build` (Firefox) / zip + Chrome Web Store upload |
| Distribute (dev) | Load unpacked from `extension/dist` |

### 8.2 Backend

Infrastructure-as-code is organised by concern into separate stacks under `backend/infrastructure/stacks/`:

| Stack | Resources |
| --- | --- |
| `api` | API Gateway WebSocket, route mappings, ws-connect, ws-disconnect, ws-audio-ingest |
| `async` | SQS queues + DLQs, EventBridge bus, asr, text-to-gloss, health-warmer |
| `storage` | DynamoDB tables (`Connections`, `Preferences`, `DictionaryMeta`), S3 pose bucket, CloudFront distribution |
| `monitoring` | CloudWatch log groups, dashboards, billing alarm, DLQ depth alarms |

Each stack can be deployed, updated, or rolled back independently. A failed deployment to one stack does not affect the others.

### 8.3 Environment Variables

| Name | Owner | Purpose |
| --- | --- | --- |
| `WS_ENDPOINT` | Extension (`src/shared/config.ts`) | The WebSocket URL to connect to |
| `ASR_MODEL` | `asr` Lambda env | `stub` (dev), `moonshine` (default real engine), `moonshine-african`, or `parakeet-tdt-streaming` (GPU, roadmap) |
| `DICTIONARY_BUCKET` | `text-to-gloss` Lambda env | S3 bucket holding the per-language dictionary metadata |
| `POSE_CDN_BASE` | (Future) content script | CloudFront base URL for pose clip fetch |

---

## 9. Security Design

| Concern | Mitigation |
| --- | --- |
| Audio in transit | TLS via WSS; API Gateway WebSocket endpoint requires `wss://` |
| Audio at rest | Not persisted at any stage; verified by code inspection and a CloudWatch query |
| Connection identity | API Gateway connection ID is opaque and per-session; no user identity is required for the prototype |
| Per-Lambda permissions | Each Lambda has its own IAM role with least-privilege policies (e.g., `ws-audio-ingest` may only `sqs:SendMessage`) |
| Extension permissions | Manifest requests only `storage`, `activeTab`, `tabCapture`, `offscreen` |
| Cross-origin overlay | Content script runs in the isolated content-script world; the overlay lives in a Shadow DOM |
| Cost-DoS | CloudWatch billing alarm at 5 USD/month; per-IP request limits at API Gateway (planned) |

---

## 10. Design Rationale and Trade-offs

### 10.1 Why Manifest V3 Offscreen Documents Instead of Service-Worker Web Audio

Manifest V3 service workers cannot use `MediaStream`, `AudioContext`, or `WebSocket` with binary frames reliably across browsers. The offscreen API (Chrome 109+, Firefox 109+) is the supported way to host these APIs. The service worker remains the orchestrator and message router, which is what it is good at.

### 10.2 Why a WebSocket Instead of HTTP POST per Frame

A 250 ms frame would mean four HTTP requests per second per user, each incurring a TCP/TLS handshake. A WebSocket amortises the handshake over the whole session, halves the per-frame overhead, and supports the cloud pushing transcripts and sign IDs back without polling.

### 10.3 Why Contiguous (Non-Overlapping) Frames

A streaming ASR model maintains internal state across frames. If consecutive frames overlap, the model double-counts the overlapped audio and the transcript quality degrades. Contiguous frames match the model's expected input contract.

### 10.4 Why Dictionary-Based Sign Mapping in Version One

Generative text-to-sign is an open research problem with no production-grade open-source model. A dictionary of pre-rendered pose clips provides deterministic, fast, instantly-playable output for the most common signs in each language. The dictionary can be extended over time without re-architecting the system.

### 10.5 Why Three.js Instead of Pre-Rendered Video Files

The dictionary stores keypoint sequences, not video frames. Three.js drives a skeletal avatar from the keypoints, which means: (a) the same sign can be played at any speed without re-encoding, (b) consecutive signs can blend smoothly at the joint level, and (c) the avatar style can be re-skinned without changing the dictionary.

### 10.6 Why eu-west-1

Latency tests from Accra to AWS regions consistently favour eu-west-1 over us-east-1 and ap-south-1. The chosen open-source ASR alternatives are all available in eu-west-1.

### 10.7 What Was Deliberately Excluded

- **Elastic Load Balancer** and **NAT Gateway** — neither is free-tier. API Gateway and Lambda already provide horizontal scaling and outbound internet access.
- **Container-based services (ECS, EKS)** — Lambda is sufficient and free-tier compatible.
- **Sign-to-speech recognition** — out of scope for this project (declared in the proposal); design avoids any architecture that would assume it later.

---

*End of Software Design Document.*
