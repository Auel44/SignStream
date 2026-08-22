# Test Plan

## SignStream: A Browser Extension for Real-Time One-Way Audio-to-Sign-Language Translation of Streaming Media

**Document Type:** Test Plan
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
2. Test Strategy
3. Test Environments
4. Entry and Exit Criteria
5. Test Levels
6. Test Cases (by requirement)
7. Test Data
8. Performance and Load Tests
9. Security and Privacy Tests
10. Usability and User Acceptance Tests
11. Defect Management
12. Test Schedule
13. Test Deliverables

---

## 1. Introduction

### 1.1 Purpose

This document describes the testing approach for SignStream. It identifies what will be tested, how, by whom, and against what criteria. It is intended to give the supervisor and second reader confidence that the system's requirements are verified and that the evidence is reproducible.

### 1.2 Scope

The plan covers unit, integration, end-to-end, performance, security, and usability testing of both the browser extension and the AWS backend.

### 1.3 References

- 01-System-Requirements-Specification.md
- 02-Software-Design-Document.md
- IMPLEMENTATION_PLAN.md (parent project root)

---

## 2. Test Strategy

### 2.1 Approach

Testing follows the testing pyramid:

| Level | Proportion | Examples |
| --- | --- | --- |
| Unit | About 60 percent | Pure-function helpers (downsample, framing, JSON encoding) |
| Integration | About 25 percent | Service-worker plus offscreen plus mock WebSocket; Lambda plus SQS plus DynamoDB |
| End-to-end | About 10 percent | Real browser plus deployed backend plus real audio source |
| Manual exploratory | About 5 percent | Cross-browser checks, real streaming sites, deaf-user feedback |

### 2.2 Automation

Automated tests are written in Vitest for the extension and Pytest for the backend. Continuous integration runs both suites on every push to the main branch via GitHub Actions.

### 2.3 Tracing

Every test case carries the identifier of the requirement it verifies (`FR-XX` or `NFR-XX`) so that the traceability matrix in the SRS can be filled in directly from test artefacts.

---

## 3. Test Environments

### 3.1 Local Development

| Component | Tooling |
| --- | --- |
| Extension | Node 20, Vite dev build, Chrome 130 (canary acceptable), Firefox 132 |
| Backend (offline simulation) | LocalStack 3.x for SQS, DynamoDB, S3; mock API Gateway WebSocket via a small Node WS server |
| Test runners | Vitest 1.x, Pytest 8.x |

### 3.2 Staging on AWS

| Component | Detail |
| --- | --- |
| Region | eu-west-1 |
| Account | Personal AWS account, free tier active |
| Stack suffix | `signstream-staging-` |
| Cost guardrail | CloudWatch billing alarm at 5 USD/month |

### 3.3 Devices for Manual Test

| Profile | Specification |
| --- | --- |
| Low-spec laptop | Intel Core i3, 8 GB RAM, integrated graphics, Windows 11 |
| Mid-spec laptop | Intel Core i5, 16 GB RAM, integrated graphics, Ubuntu 22.04 |
| Network | Tethered mobile data (representative of typical Ghana broadband) and home Wi-Fi |

---

## 4. Entry and Exit Criteria

### 4.1 Entry Criteria

Testing begins on a build when:

- The build compiles in TypeScript strict mode with zero errors.
- All unit and integration tests pass locally.
- The extension manifest validates against the Manifest V3 schema.
- The backend infrastructure plan applies cleanly to a staging account.

### 4.2 Exit Criteria

Testing is considered complete for a release candidate when:

- All Must-priority functional requirements (FR-01 to FR-40 marked Must) have at least one passing test case.
- All Must-priority non-functional requirements have measured evidence within target.
- No open Severity-1 (blocker) or Severity-2 (critical) defects remain.
- Open Severity-3 (minor) and Severity-4 (trivial) defects are documented and triaged.
- The traceability matrix in the SRS is filled with green status for every Must row.

---

## 5. Test Levels

### 5.1 Unit Tests

Run with Vitest (extension) and Pytest (backend). Examples of in-scope units:

| Module | Functions to test |
| --- | --- |
| Offscreen helpers | `downsampleTo16k`, `float32ToInt16`, `rootMeanSquare`, framing accumulator |
| Service worker | `getSettings`, `saveSettings`, `relayToContent` routing logic |
| Popup reducers (if extracted) | Settings update reducer; state transitions for `captureActive` |
| Shared `types.ts` | Snapshot of message-union exhaustiveness in a TS narrow test |
| Lambda `ws-audio-ingest` | Payload validation, SQS send retry behaviour |
| Lambda `text-to-gloss` | Normalisation rules (lowercase, punctuation strip, contraction expansion); dictionary lookup; unknown-gloss fallback |
| Lambda `asr` | Partial-vs-final transcript emission; backpressure handling on slow downstream |

### 5.2 Integration Tests

Run against LocalStack and a mock WebSocket server. Examples:

- Frame from offscreen reaches the mock server in correct binary format, correct rate, and correct sequence ordering.
- Service worker forwards a `TRANSCRIPT` from a mock cloud message to the content script.
- `ws-audio-ingest` enqueues to LocalStack SQS; `asr` consumes; result published to LocalStack EventBridge.
- Dead-letter behaviour: a hand-crafted poison frame ends up in `audio-dlq` after the expected number of redrives.

### 5.3 End-to-End Tests

Run against staging on AWS with a scripted scenario:

| Scenario | Steps |
| --- | --- |
| Smoke | Open YouTube, enable signing, verify overlay appears, verify cloud-connected dot, verify at least one transcript and one sign ID within five seconds of audio. |
| Language switch | While signing is active, change language from ASL to BSL; verify the cloud session updates without re-capture and the next sign played belongs to the new language. |
| Reconnect | Drop the backend by temporarily disabling its Lambda; verify the offscreen reconnects with exponential backoff once the Lambda is re-enabled. |
| Pause and resume | Pause the host video; verify the avatar pauses; resume; verify the avatar resumes. |
| Settings persist | Change settings, close the browser, reopen; verify settings persist via `chrome.storage.sync`. |

### 5.4 Cross-Browser Tests

Repeat the smoke and language-switch scenarios on Firefox 132 to verify identical behaviour. Capture any per-browser quirks in the defect tracker.

---

## 6. Test Cases (by Requirement)

The full test-case sheet is maintained in `docs/supervisor/test-cases.xlsx`. A representative subset is reproduced here.

### 6.1 Functional

| ID | Requirement | Steps | Expected Result | Status |
| --- | --- | --- | --- | --- |
| TC-01 | FR-01 | Open the popup; click the Signing Avatar toggle | The toggle visibly switches state and the status label changes to "Starting…" then "Capturing tab audio" within 2 s | Pending |
| TC-02 | FR-02 | Open the popup; change the language dropdown to BSL | The dropdown updates; the persisted setting is `language=BSL` (verified via `chrome.storage.sync`); if capture is active, an `OFFSCREEN_SET_LANGUAGE` message is observed | Pending |
| TC-03 | FR-06 | Change settings; close browser; reopen | Settings reflect the new values | Pending |
| TC-04 | FR-08 | Enable signing on a YouTube tab | The service-worker console logs at least one `chunk #n` line within 500 ms; the tab audio continues to play | Pending |
| TC-05 | FR-10, FR-11 | Capture from a 48 kHz source for 60 s | All emitted frames are exactly 4000 Int16 samples (250 ms at 16 kHz), monotonically numbered, with no gaps | Pending |
| TC-06 | FR-15 | Stop the backend; wait 5 s; restart | The offscreen logs reconnect attempts at 1, 2, 4 s; reconnect succeeds; `CLOUD_STATUS connected=true` arrives at the popup | Pending |
| TC-07 | FR-19 | Inspect client memory and storage during capture | No audio frames appear in `chrome.storage` or `IndexedDB`; audio is never written to disk by the extension | Pending |
| TC-08 | FR-22 | Send 30 s of speech audio; inspect ASR Lambda logs | At least one transcript event per spoken sentence; events arrive on `signstream-bus` | Pending |
| TC-09 | FR-26 | After a session, run a CloudWatch query for any S3, DynamoDB, or EBS write tied to raw audio | Zero results | Pending |
| TC-10 | FR-30 | With signing enabled and audio playing, watch the overlay | Avatar plays gestures in the same order as the cloud emits sign IDs; no gestures are skipped | Pending |
| TC-11 | FR-31 | Pause the host video while signing | The avatar pauses within 100 ms; transcript stops updating | Pending |
| TC-12 | FR-34 | Disable signing | The overlay is removed from the page; no residual nodes remain (verified with `document.getElementById('signstream-overlay-host') === null`) | Pending |
| TC-13 | FR-35 | Switch through ASL → BSL → GhSL on a sample sentence | Each language produces a different sign-ID sequence drawn from its own dictionary | Pending |
| TC-14 | FR-39 | After a 30-min session, open CloudWatch dashboards | Queue depth, Lambda invocations, errors, and DLQ counts are populated and non-zero (queue depth never exceeds 100) | Pending |
| TC-15 | FR-40 | Inspect the AWS Billing console | A billing alarm exists, is enabled, and has a configured threshold | Pending |

### 6.2 Non-Functional

| ID | Requirement | Steps | Pass Threshold | Status |
| --- | --- | --- | --- | --- |
| TC-50 | NFR-01 | Play a calibrated audio file with a marker tone; measure the time from the marker until the first frame of the corresponding sign is rendered | Median ≤ 1.5 s; 95th percentile ≤ 2.5 s | Pending |
| TC-51 | NFR-02 | Same as TC-50 but measure time to first partial transcript | Median ≤ 800 ms | Pending |
| TC-52 | NFR-03 | Run capture and avatar rendering on the low-spec laptop for 10 minutes | Avatar maintains ≥ 24 fps; no dropped capture frames | Pending |
| TC-53 | NFR-06 | Disconnect Wi-Fi for 15 s and reconnect | Reconnect within 30 s | Pending |
| TC-54 | NFR-09 | Watch a new user (untrained) install and use the extension on a sample video | Time to first sign on screen ≤ 5 min | Pending |
| TC-55 | NFR-11 | Run automated accessibility audit on the popup | Zero AA-level violations | Pending |
| TC-56 | NFR-13 | Capture the WebSocket traffic with the browser network panel | All audio frames carried over WSS; no plain-text WS observed | Pending |
| TC-57 | NFR-23 | Run a five-user, 30-minute session daily for a week against staging | AWS bill remains within free tier | Pending |

---

## 7. Test Data

### 7.1 Audio Sources

- **Synthetic.** Three calibrated WAV files containing scripted English sentences spoken at normal pace by a synthetic voice. Used for deterministic latency and ASR-accuracy tests.
- **Real streaming media.** A small set of public YouTube videos covering: a news bulletin, a TED-style talk, a cooking tutorial, and a music video with spoken interludes. Used for realistic end-to-end tests.

### 7.2 Sign Dictionaries

- **ASL test dictionary.** 50 of the most common ASL signs, with pose clips, used for the smoke scenario.
- **BSL test dictionary.** 25 most common BSL signs.
- **GhSL test dictionary.** Initially 25 signs curated with input from local GhSL teachers.

### 7.3 Ground Truth

Each audio source is paired with: a verified ground-truth transcript, a hand-aligned word-level timing file (for latency measurement), and a hand-curated gloss sequence per supported language (for translation evaluation).

---

## 8. Performance and Load Tests

### 8.1 Single-User Latency

- **Tool.** A small script that emits a 1 kHz click tone every 5 s while the user plays a known audio file.
- **Measure.** Time from click tone to (a) first partial transcript and (b) first avatar frame.
- **Targets.** See TC-50 and TC-51.

### 8.2 Concurrency

- **Tool.** A small Node script that opens five concurrent WebSocket sessions, each emitting frames from the synthetic audio in real time.
- **Measure.** Per-session 95th-percentile transcript latency under five concurrent users.
- **Targets.** No transcript latency increase greater than 200 ms compared with single-user.

### 8.3 Cold Start

- **Tool.** Manual session opened after a 20-minute period of backend inactivity (no health-warmer firing).
- **Measure.** Time from `START_CAPTURE` to first transcript.
- **Targets.** First transcript within 3 s on a cold start; subsequent transcripts within target.

### 8.4 Endurance

- **Tool.** A 60-minute continuous YouTube playback session with signing enabled.
- **Measure.** Memory usage in the offscreen document and content script at start, 30 min, 60 min; total dropped frames.
- **Targets.** Memory growth in offscreen document below 50 MB; zero dropped capture frames; zero crashes.

---

## 9. Security and Privacy Tests

| ID | Description | Pass Threshold |
| --- | --- | --- |
| SEC-01 | Verify all WebSocket traffic uses WSS (TLS 1.2 or higher) | 100% of frames encrypted |
| SEC-02 | Verify the manifest requests only the four declared permissions | Manifest review confirms; Chrome warning does not include `<all_urls>` |
| SEC-03 | Verify no audio bytes are written to any persistent storage (client and cloud) | Code review and CloudWatch query both negative |
| SEC-04 | Verify each Lambda's IAM role has least-privilege actions | IAM policy export reviewed; no `*` actions |
| SEC-05 | Verify a stale WebSocket connection ID is removed from DynamoDB when API GW returns Gone | Manual test by terminating a connection and waiting for the cleanup invocation |
| SEC-06 | Verify the popup and overlay do not embed or execute third-party scripts | Network panel review |

---

## 10. Usability and User Acceptance Tests

### 10.1 Participants

A minimum of four participants, of whom at least two are deaf or hard-of-hearing. Recruited through the Ghana National Association of the Deaf and the KNUST deaf student community. Participants are compensated for their time at the customary rate.

### 10.2 Protocol

1. Brief the participant on the purpose of the study and obtain written or video-signed informed consent.
2. Ask the participant to install the extension from a development build on a provided laptop.
3. Ask the participant to enable signing on a five-minute prepared video.
4. Observe and note where the participant hesitates or makes errors.
5. Conduct a semi-structured 15-minute interview covering: clarity of the signing, comfort of the avatar position and size, helpfulness of the transcript caption, and what would be needed to make the participant adopt the extension in everyday use.
6. Administer the System Usability Scale (SUS).

### 10.3 Targets

- Median SUS score: 70 or higher.
- At least three of the four participants successfully reach a signed translation without facilitator help.
- At least one explicit improvement idea is recorded and triaged.

### 10.4 Ethics

Approval from the institutional ethics committee is obtained before any user testing begins. No audio or video of participants is recorded. Only anonymised survey responses and observational notes are retained.

---

## 11. Defect Management

### 11.1 Tracker

GitHub Issues, with labels `bug`, `severity-1`, `severity-2`, `severity-3`, `severity-4`, and `area:extension`, `area:backend`, `area:dictionary`.

### 11.2 Severity Definitions

| Severity | Definition |
| --- | --- |
| 1 — Blocker | Renders the system unusable for its primary purpose (cannot capture audio, cannot reach the cloud, avatar never plays). |
| 2 — Critical | Significant functional loss but a workaround exists (one language fails; pause-resume desyncs the avatar). |
| 3 — Minor | Cosmetic or low-impact functional issue (caption text overflows the container). |
| 4 — Trivial | Nice-to-have or polish (icon misalignment). |

### 11.3 Triage Cadence

The supervisor and the student review open defects weekly during scheduled supervision. Severity-1 and Severity-2 defects are addressed before the next scheduled inspection.

---

## 12. Test Schedule

| Week | Activity |
| --- | --- |
| 1 | Set up CI; write unit tests for shared helpers; baseline accessibility audit |
| 2 | Service-worker and offscreen integration tests against mock WS server |
| 3 | Backend integration tests against LocalStack |
| 4 | Deploy to staging; smoke and reconnect E2E tests on YouTube |
| 5 | Latency measurement on synthetic audio; tune frame and queue sizes |
| 6 | Concurrency and endurance tests; tune Lambda timeouts and memory |
| 7 | Cross-browser run on Firefox; fix per-browser defects |
| 8 | User acceptance testing with deaf participants |
| 9 | Defect-fix sprint; regression test pass |
| 10 | Final regression; lock release-candidate build for the demonstration |

---

## 13. Test Deliverables

By the end of the project, the following test artefacts will be delivered alongside the code:

- A `test/` directory in both the extension and the backend with all unit and integration test sources.
- A CI configuration (`.github/workflows/test.yml`) that runs the full suite on every push.
- A test-case sheet (`docs/supervisor/test-cases.xlsx`) recording every test case, requirement reference, status, and evidence link.
- Latency, concurrency, and endurance result reports under `docs/supervisor/results/`.
- An accessibility audit report under `docs/supervisor/results/accessibility.html`.
- Anonymised user-test notes and SUS results under `docs/supervisor/results/user-tests/`.
- A signed sample CloudWatch billing report showing free-tier compliance.

---

*End of Test Plan.*
