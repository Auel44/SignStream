# System Requirements Specification (SRS)

## SignStream: A Browser Extension for Real-Time One-Way Audio-to-Sign-Language Translation of Streaming Media

**Document Type:** System Requirements Specification
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
2. Overall Description
3. External Interface Requirements
4. Functional Requirements
5. Non-Functional Requirements
6. System Constraints
7. Assumptions and Dependencies
8. Acceptance Criteria
9. Traceability Matrix
10. Glossary

---

## 1. Introduction

### 1.1 Purpose

This document specifies the functional and non-functional requirements for SignStream, a browser extension that captures the audio of streaming media playing in a browser tab, transcribes the speech in the cloud, maps the resulting text to a sign-language gloss sequence, and renders an on-screen avatar that signs the speech back to a deaf user in their chosen sign language (American Sign Language, British Sign Language, or Ghanaian Sign Language). The document is intended for the project supervisor, the second reader, and any contributor who must understand what the system is required to do and the basis on which it will be evaluated.

### 1.2 Scope

SignStream consists of two deployable parts:

1. A Manifest V3 browser extension (Chrome and Firefox) that runs entirely on the user's machine.
2. A serverless AWS backend (eu-west-1) that performs streaming speech recognition and text-to-gloss mapping.

The system is **strictly one-way**: audio is the input, an animated sign-language avatar is the output. The system does not recognise sign language from video, does not synthesise speech, does not perform two-way conferencing, and does not modify any host website's audio or video. It is positioned as an assistive prototype, not a replacement for qualified human interpreters.

### 1.3 Definitions, Acronyms, and Abbreviations

| Term | Meaning |
| --- | --- |
| ASR | Automatic Speech Recognition |
| ASL | American Sign Language |
| BSL | British Sign Language |
| GhSL | Ghanaian Sign Language |
| Gloss | A written label representing a single sign |
| MV3 | Manifest V3, the current Chrome and Firefox extension manifest version |
| PCM | Pulse-Code Modulation, the linear audio sample format used internally |
| RMS | Root Mean Square, an audio amplitude measure |
| SLP | Sign Language Processing |
| WS | WebSocket |
| WSS | WebSocket Secure |

### 1.4 References

- Project proposal: PROPOSAL.md (parent project root).
- Implementation plan: IMPLEMENTATION_PLAN.md.
- Backend design notes: backend/README.md.
- Extension status notes: extension/README.md.

### 1.5 Overview of the Document

Sections 1 and 2 give context. Section 3 lists the external interfaces (user, hardware, software). Sections 4 and 5 contain the functional and non-functional requirements respectively. Section 6 records constraints. Section 7 records assumptions and dependencies. Section 8 defines the acceptance criteria. Section 9 cross-references requirements to project artefacts. Section 10 is a glossary.

---

## 2. Overall Description

### 2.1 Product Perspective

SignStream is a self-contained accessibility product. It does not integrate with any specific streaming platform; it operates on the audio of any browser tab. The browser is the primary host environment. The cloud backend is consumed only by the extension and is not exposed as a public API in this version.

### 2.2 Product Functions

At a high level, SignStream:

1. Allows a deaf user to enable signing on the active browser tab from a toolbar popup.
2. Captures the tab's audio without interfering with playback.
3. Streams the captured audio in fixed-size frames to a cloud backend.
4. Receives partial and final English transcripts from the cloud.
5. Receives a sign-identifier sequence corresponding to the transcripts.
6. Renders an avatar that signs the corresponding signs in sync with the playing video.
7. Optionally displays the live transcript as captions alongside the avatar.
8. Persists user preferences (language, avatar position and size, transcript toggle).

### 2.3 User Characteristics

The primary user is an adult deaf or hard-of-hearing person whose first language is a sign language (ASL, BSL, or GhSL) and who consumes web-based streaming media (YouTube, news sites, educational platforms, podcasts). The user is assumed to have basic familiarity with installing a browser extension. No specialist hardware is assumed.

### 2.4 Operating Environment

| Environment | Specification |
| --- | --- |
| Client browser | Chrome 116+ or Firefox 109+ (Manifest V3 with offscreen API support) |
| Client OS | Windows 10+, macOS 12+, Ubuntu 22.04+ (any OS the supported browsers run on) |
| Client hardware | 4 GB RAM or higher; modest CPU; on-board audio output; no GPU required |
| Network | Standard residential broadband; 1 Mbps upload sufficient for the audio stream |
| Backend region | AWS eu-west-1 (Ireland); chosen for latency from Ghana |
| Backend services | API Gateway (WebSocket), Lambda, DynamoDB, SQS, EventBridge, S3, CloudFront, CloudWatch |

### 2.5 Design and Implementation Constraints

- No heavy machine-learning inference may run on the client.
- The backend must stay within AWS always-free monthly allowances at small scale.
- Audio chunks must not be persisted server-side.
- The extension must function entirely within the browser sandbox (no native messaging, no system-level audio drivers).

### 2.6 User Documentation

A short README in the extension directory describes installation, usage, and verification. A separate technical README in the backend directory describes deployment, fault isolation, and cost guardrails.

---

## 3. External Interface Requirements

### 3.1 User Interfaces

**Toolbar Popup.** A small UI surface (about 320 by 480 pixels) opened by clicking the extension icon. Contains: a master Signing-Avatar toggle, a Sign-Language dropdown (ASL, BSL, GhSL), Avatar-Position (Bottom Right, Bottom Left), Avatar-Size (Small, Medium, Large), a Show-Live-Transcript checkbox, a capture-status indicator, a cloud-status indicator, and a live transcript preview.

**On-Page Overlay.** A floating, rounded container drawn by the content script on the host page when signing is active. Contains a canvas (the avatar) and a caption strip. Mounted inside a Shadow DOM so the host page's CSS cannot interfere with it.

### 3.2 Hardware Interfaces

The system uses only the audio output device of the host machine (passthrough so the user continues to hear the original audio while it is being processed) and the display. No microphone, camera, or other hardware is used.

### 3.3 Software Interfaces

- **Browser APIs:** chrome.action, chrome.storage.sync, chrome.tabs, chrome.runtime, chrome.tabCapture, chrome.offscreen, navigator.mediaDevices.getUserMedia, WebSocket, AudioContext, ScriptProcessorNode, requestAnimationFrame.
- **Backend APIs (consumed by the extension):** AWS API Gateway WebSocket endpoint (`wss://<id>.execute-api.eu-west-1.amazonaws.com/prod`), Amazon CloudFront for pose-asset delivery.

### 3.4 Communication Interfaces

Audio chunks are sent as raw binary WebSocket frames (Int16 little-endian PCM at 16 kHz mono, 250 ms per frame). Control and result messages use JSON text frames over the same socket. The schemas are defined in [extension/src/shared/types.ts](../../extension/src/shared/types.ts).

---

## 4. Functional Requirements

Each requirement is given a unique identifier in the form `FR-XX` and a priority of Must, Should, or May (MoSCoW).

### 4.1 Settings and Preferences

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-01 | The system shall allow the user to enable or disable the signing avatar from the popup. | Must |
| FR-02 | The system shall allow the user to choose a sign language from ASL, BSL, and GhSL. | Must |
| FR-03 | The system shall allow the user to choose the avatar position (bottom right or bottom left). | Should |
| FR-04 | The system shall allow the user to choose the avatar size (small, medium, large). | Should |
| FR-05 | The system shall allow the user to enable or disable the live transcript caption. | Should |
| FR-06 | The system shall persist all preferences across browser sessions and machines using chrome.storage.sync. | Must |
| FR-07 | The system shall apply preference changes to the on-page overlay without requiring re-capture. | Should |

### 4.2 Tab Audio Capture

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-08 | The system shall capture the audio of the currently active browser tab when the user enables signing. | Must |
| FR-09 | The system shall pass the captured audio through to the user's audio output so the original video continues to play normally. | Must |
| FR-10 | The system shall downsample the captured audio to 16 kHz mono PCM regardless of the source rate. | Must |
| FR-11 | The system shall frame the downsampled audio into contiguous, non-overlapping 250 ms windows. | Must |
| FR-12 | The system shall stop the audio capture cleanly when the user disables signing or closes the tab. | Must |
| FR-13 | The system shall not capture audio when signing is disabled. | Must |

### 4.3 Cloud Streaming

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-14 | The system shall stream each captured 250 ms audio frame as a binary WebSocket message to the configured backend endpoint. | Must |
| FR-15 | The system shall reconnect to the backend automatically with exponential backoff (1 s, 2 s, 4 s, 8 s, capped at 10 s) on disconnection. | Must |
| FR-16 | The system shall continue capture and local passthrough even when the WebSocket is disconnected (frames are dropped, not buffered indefinitely). | Must |
| FR-17 | The system shall report the cloud connection state (connected, disconnected) to the popup. | Must |
| FR-18 | The system shall send a setLanguage control message when the language preference changes during an active capture. | Must |
| FR-19 | The system shall not persist any captured audio on the client. | Must |

### 4.4 Cloud-Side Processing

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-20 | The backend shall accept WebSocket connections at the configured endpoint and register each connection in DynamoDB. | Must |
| FR-21 | The backend shall enqueue each incoming audio frame to an SQS queue and acknowledge receipt to the client without performing synchronous processing in the WebSocket route. | Must |
| FR-22 | The backend shall consume the audio queue with a streaming ASR Lambda and publish a transcript event for each finalised text segment. | Must |
| FR-23 | The backend shall consume transcript events with a text-to-gloss Lambda that normalises the text, maps it to a controlled gloss vocabulary, and emits one or more sign identifiers. | Must |
| FR-24 | The backend shall push partial and final transcripts back to the originating WebSocket client. | Must |
| FR-25 | The backend shall push each emitted sign identifier back to the originating WebSocket client. | Must |
| FR-26 | The backend shall not persist any audio data beyond the duration required to process a single frame in memory. | Must |
| FR-27 | The backend shall route failed messages to a dead-letter queue rather than blocking the live pipeline. | Must |

### 4.5 Avatar Rendering

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-28 | The system shall display the avatar overlay on the active page only while capture is active. | Must |
| FR-29 | The system shall render the avatar using Three.js inside a Shadow-DOM-isolated overlay container. | Must |
| FR-30 | The system shall animate the avatar to play the gesture for each incoming sign identifier in the order received. | Must |
| FR-31 | The system shall synchronise avatar playback to the host page's primary video element using video.currentTime where a video is detected. | Should |
| FR-32 | The system shall pause avatar playback when the host video is paused and resume when it plays. | Should |
| FR-33 | The system shall display the live transcript caption beneath the avatar when the corresponding preference is enabled. | Should |
| FR-34 | The system shall remove the overlay cleanly when capture stops, leaving no residual DOM nodes. | Must |

### 4.6 Multi-Language Support

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-35 | The system shall support ASL, BSL, and GhSL as user-selectable sign languages. | Must |
| FR-36 | The architecture shall allow adding additional sign languages by supplying a dictionary directory and a gloss-mapping rule set, without modifying the extension or backend stacks. | Must |
| FR-37 | The system shall fall back to displaying transcript captions only when a chosen language's dictionary does not cover a requested gloss. | Should |

### 4.7 Observability

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-38 | The system shall log per-frame statistics (sequence number, sample rate, samples, duration, RMS, sent flag) to the service worker console. | Should |
| FR-39 | The backend shall emit CloudWatch metrics for queue depth, Lambda invocations, errors, and DLQ message counts. | Must |
| FR-40 | The system shall configure a CloudWatch billing alarm at the AWS account level from initial deployment. | Must |

---

## 5. Non-Functional Requirements

### 5.1 Performance

| ID | Requirement | Target |
| --- | --- | --- |
| NFR-01 | End-to-end latency from a spoken word to the first frame of the corresponding sign being rendered. | Median ≤ 1.5 s; 95th percentile ≤ 2.5 s |
| NFR-02 | First partial transcript displayed to the user. | Median ≤ 800 ms after the speech |
| NFR-03 | Avatar rendering frame rate on a low-spec laptop (Intel i3-class, integrated graphics). | ≥ 24 fps |
| NFR-04 | Audio capture must not drop frames at the source. | Zero dropped frames during 30-minute stress test |
| NFR-05 | Cloud frame ingest acknowledgement latency. | Median ≤ 150 ms |

### 5.2 Reliability

| ID | Requirement | Target |
| --- | --- | --- |
| NFR-06 | The WebSocket client must reconnect automatically after a transient disconnection within 30 seconds. | 99% of disconnections |
| NFR-07 | A fault in any single backend Lambda must not prevent connection registration or audio capture from continuing. | Verified by fault-injection test |
| NFR-08 | Audio passthrough to the user's speakers must continue even if every cloud component is unavailable. | Verified by offline test |

### 5.3 Usability

| ID | Requirement | Target |
| --- | --- | --- |
| NFR-09 | A new user must be able to install the extension, enable signing on a test video, and see the avatar render within five minutes. | Median time to first sign ≤ 5 min in user testing |
| NFR-10 | All popup controls must be keyboard accessible (Tab, Enter, Space, Escape). | All controls verified |
| NFR-11 | The popup must meet WCAG 2.1 AA colour-contrast ratios. | Verified by automated audit |
| NFR-12 | The avatar overlay must be draggable away from any region of the page if the default position obscures content. | Should |

### 5.4 Security and Privacy

| ID | Requirement | Target |
| --- | --- | --- |
| NFR-13 | All audio in transit between the extension and the backend must be encrypted using TLS (WebSocket Secure, WSS). | 100% of frames |
| NFR-14 | No audio data shall be persisted server-side at any stage of the pipeline. | Verified by code inspection and a CloudWatch query for any storage write tied to audio data |
| NFR-15 | The extension must request only the permissions listed in Section 6.1. | Verified by manifest review |
| NFR-16 | The backend must use IAM least-privilege roles per Lambda. | Verified by IAM policy review |

### 5.5 Maintainability

| ID | Requirement | Target |
| --- | --- | --- |
| NFR-17 | The extension and backend source code must compile under TypeScript strict mode with no errors. | Verified by CI |
| NFR-18 | Each backend Lambda must live in its own folder with its own dependencies. | Verified by directory structure |
| NFR-19 | Adding a new sign language must require no code changes outside the dictionary folder and the language enum. | Verified by adding GhSL test case |
| NFR-20 | Test coverage on the extension shared modules and backend pure-logic modules. | ≥ 70% lines |

### 5.6 Portability

| ID | Requirement | Target |
| --- | --- | --- |
| NFR-21 | The extension must run identically on Chrome and Firefox without per-browser code branches in business logic. | Verified by manual test on both browsers |
| NFR-22 | The backend deployment must be reproducible from infrastructure-as-code on any AWS account in eu-west-1. | Verified by deploy-from-clean-account dry run |

### 5.7 Cost

| ID | Requirement | Target |
| --- | --- | --- |
| NFR-23 | The system must operate within AWS always-free monthly allowances at the demonstrated load (up to five concurrent users, 30 minutes per user, daily). | Verified by AWS billing report |
| NFR-24 | A CloudWatch billing alarm must trigger at a configurable monthly threshold (default 5 USD). | Verified by alarm test |

---

## 6. System Constraints

### 6.1 Permissions

The extension shall request only the following Chrome permissions:

- `storage` — for persisting user preferences via `chrome.storage.sync`.
- `activeTab` — to identify which tab the user is currently viewing when signing is enabled.
- `tabCapture` — to obtain the audio MediaStream of the active tab.
- `offscreen` — to host the Web Audio pipeline in an offscreen document (required because Manifest V3 service workers cannot use Web Audio).

The extension shall not request `<all_urls>` host permissions beyond what is required for the content-script overlay match pattern.

### 6.2 Regulatory and Standards Compliance

- WCAG 2.1 AA for the popup user interface.
- AWS Well-Architected Framework: Security and Cost pillars.
- Manifest V3 specification (Chrome and Firefox).
- TypeScript strict-mode for all production source code.

### 6.3 Technology Stack

| Layer | Technology | Justification |
| --- | --- | --- |
| Extension shell | Manifest V3 | Required by browser stores |
| Extension UI | React 18 + TypeScript + Vite + Tailwind | Mature, type-safe, fast iteration |
| Audio capture | Web Audio API in an offscreen document | Standard MV3 pattern |
| Avatar rendering | Three.js | Production-grade WebGL, runs on integrated graphics |
| Backend orchestration | AWS Lambda + API Gateway WebSocket | Serverless, free-tier-compatible |
| Backend queues and events | SQS + EventBridge | Loose coupling, dead-letter queues |
| Speech recognition | Moonshine ONNX (MIT) — fast on CPU; AfriSpeech-fine-tuned for Ghana. Parakeet TDT reserved as a GPU upgrade. | Open-source streaming ASR that runs on the free-tier CPU |
| Configuration store | DynamoDB (sessions, preferences); chrome.storage.sync (client) | Free tier; native to each side |
| Asset delivery | S3 + CloudFront | Free monthly allowances; edge cache near Accra |
| Observability | CloudWatch logs, metrics, alarms | Native to AWS, free at small scale |

---

## 7. Assumptions and Dependencies

1. The streaming media played in the user's tab does not enforce DRM-level audio restrictions that prevent `chrome.tabCapture` from accessing the audio. Where DRM blocks capture (some Netflix titles), the extension will simply produce no transcript; this is documented to the user.
2. The user has a network connection of at least 1 Mbps upload bandwidth for the audio stream.
3. The streaming media is in English. Non-English audio is out of scope for this version.
4. The user has installed a supported version of Chrome (116+) or Firefox (109+).
5. AWS eu-west-1 will remain available with the chosen service set under always-free pricing for the duration of the project.
6. The open-source ASR model selected (Parakeet TDT or alternative) provides streaming inference latency within target bounds when deployed in Lambda.

---

## 8. Acceptance Criteria

The system will be considered to meet its requirements when:

1. The extension installs cleanly on Chrome and Firefox without warnings.
2. Enabling signing on a YouTube video produces a visible avatar overlay and live transcript within the latency targets in Section 5.1.
3. All Must-priority functional requirements are demonstrated end to end on each of ASL, BSL, and GhSL.
4. A 30-minute continuous capture session runs without dropped frames or memory growth beyond 50 MB in the offscreen document.
5. A user-testing session with at least four participants (including at least two deaf participants) produces a System Usability Scale (SUS) score of 70 or higher.
6. The monthly AWS bill for the demonstrated load is within the free tier (≤ 1 USD outside of optional data transfer).
7. All Must-priority non-functional requirements are demonstrated with documented test evidence.

---

## 9. Traceability Matrix

| Requirement | Source Artefact | Evidence Artefact |
| --- | --- | --- |
| FR-01 to FR-07 | extension/src/popup/App.tsx | Manual test transcript; UI screenshots |
| FR-08 to FR-13 | extension/src/background/service-worker.ts, extension/src/offscreen/offscreen.ts | Service worker console log, audio capture verification |
| FR-14 to FR-19 | extension/src/offscreen/offscreen.ts | Network panel capture, reconnection log |
| FR-20 to FR-27 | backend/functions/* | Lambda invocation logs, CloudWatch traces |
| FR-28 to FR-34 | extension/src/content/overlay.ts, avatar.ts, video-sync.ts | Page screenshots; DOM inspection |
| FR-35 to FR-37 | dictionary/, extension/src/shared/types.ts | Dictionary diff test; language-switch test |
| FR-38 to FR-40 | extension/src/background/service-worker.ts, backend/infrastructure/stacks/monitoring | CloudWatch dashboard screenshot |
| NFR-01 to NFR-05 | end-to-end test harness (planned) | Latency-measurement report |
| NFR-06 to NFR-08 | offscreen reconnection logic, backend DLQ wiring | Fault-injection test report |
| NFR-09 to NFR-12 | popup/App.tsx, overlay.ts | User-test SUS forms; accessibility audit |
| NFR-13 to NFR-16 | manifest.json, IAM policies | Manifest review, IAM policy export |
| NFR-17 to NFR-20 | tsconfig.json, CI pipeline | CI build log; test-coverage report |
| NFR-21 to NFR-22 | manifest variants, Terraform plans | Cross-browser test report; deploy-clean dry run |
| NFR-23 to NFR-24 | backend/infrastructure/stacks/monitoring | AWS billing report; alarm test |

---

## 10. Glossary

- **Capture**: the ongoing process of obtaining audio from the active tab and forwarding it to the cloud.
- **Frame**: one fixed-size unit of audio (250 ms at 16 kHz mono).
- **Gloss**: a written label representing a single sign (for example, `HELLO`, `THANK-YOU`).
- **Offscreen document**: an HTML document opened by a Manifest V3 extension's service worker to host APIs unavailable to the service worker itself.
- **Sign ID**: a stable identifier for a single sign in the dictionary (for example, `asl-hello-v1`).
- **Shadow DOM**: a DOM tree attached to a host element whose styles are isolated from the parent document.
- **Streaming ASR**: a speech-recognition mode that emits partial results before the end of an utterance.
- **WebSocket Secure (WSS)**: the TLS-encrypted variant of the WebSocket protocol.

---

*End of System Requirements Specification.*
