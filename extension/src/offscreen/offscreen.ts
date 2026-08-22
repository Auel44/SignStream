// Offscreen document: captures tab audio, optionally passes it through to the
// speakers, and streams 16 kHz mono PCM to the cloud over a WebSocket. Results
// (transcripts / sign IDs) coming back are forwarded to the service worker.
//
// The resample/frame/encode work runs on the audio thread in pcm-worklet.ts,
// not here — this document only owns the socket and the graph wiring.
//
// Loose coupling: the socket is owned here (next to the PCM). If the cloud is
// unreachable, capture and passthrough keep working — frames are simply dropped
// and the popup shows "disconnected". Capture never fails because the cloud is down.

import {
  FRAME_MS,
  TARGET_SAMPLE_RATE,
  type ClientControlMessage,
  type CloudResponse,
  type ExtensionMessage,
  type SignLanguage,
} from "../shared/types";
import { wsUrlForLanguage } from "../shared/config";
// Type-only: the worklet itself is loaded by URL, never imported at runtime.
import type { PcmFrameMessage } from "./pcm-worklet";

const MAX_BACKOFF_MS = 10000;

interface Capture {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  /** Audio-thread tap that resamples, frames and Int16-encodes the PCM. */
  tap: AudioWorkletNode;
  /** Speaker path. Its gain is the mute switch; the capture path is separate. */
  passthroughGain: GainNode;
}

/** Built worklet module, resolved through the extension's own origin. */
const WORKLET_URL = chrome.runtime.getURL("src/offscreen/pcm-worklet.js");

let capture: Capture | null = null;
let socket: WebSocket | null = null;
let endpoint = "";
let language: SignLanguage = "ASL";
/** Whether captured audio is routed back to the speakers. See ExtensionSettings. */
let passthrough = true;
let seq = 0;
/**
 * Whether audio frames are uploaded for transcription.
 *
 * False when the page's caption track already supplies the words — there is
 * nothing for ASR to add, and streaming anyway would burn bandwidth and cloud
 * inference for a worse transcript. Capture itself is untouched: it still
 * feeds the speakers and the level meter.
 */
let streaming = true;
let reconnectTimer: number | undefined;
let backoff = 1000;

// ── Message handling from the service worker ──────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  switch (message.type) {
    case "OFFSCREEN_START":
      endpoint = message.wsEndpoint;
      language = message.language;
      passthrough = message.audioPassthrough;
      start(message.streamId).catch(reportError);
      break;
    case "OFFSCREEN_STOP":
      stop();
      break;
    case "OFFSCREEN_SET_LANGUAGE":
      language = message.language;
      sendControl({ action: "setLanguage", language });
      break;
    case "OFFSCREEN_SET_STREAMING":
      streaming = message.enabled;
      break;
    case "OFFSCREEN_MAP_TEXT":
      // Caption path: no audio involved, just text plus the time it belongs to.
      sendControl({ action: "mapText", text: message.text, at: message.at });
      break;
    case "OFFSCREEN_SET_PASSTHROUGH":
      passthrough = message.audioPassthrough;
      // Ramp rather than jump: a hard gain change on live audio produces an
      // audible click. Transcription is unaffected either way.
      if (capture) {
        const { context, passthroughGain } = capture;
        passthroughGain.gain.setTargetAtTime(
          passthrough ? 1 : 0,
          context.currentTime,
          0.015,
        );
      }
      break;
  }
});

// ── Capture ───────────────────────────────────────────────────────────────────────

async function start(streamId: string): Promise<void> {
  stop();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    } as unknown as MediaTrackConstraints,
    video: false,
  });

  // Default-rate context keeps playback full quality; we downsample for ASR.
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);

  // Two independent paths off the same source:
  //
  //   source → passthroughGain → speakers   (what the room hears)
  //   source → tap                          (what goes to the cloud)
  //
  // They must stay independent. tabCapture takes the tab's audio OUT of the
  // normal output, so muting here means simply not feeding the speaker path —
  // and because transcription taps `source` directly, muting costs the ASR
  // nothing. Using a GainNode rather than disconnecting lets the user toggle
  // mid-stream without rebuilding the graph or dropping a frame.
  const passthroughGain = context.createGain();
  passthroughGain.gain.value = passthrough ? 1 : 0;
  source.connect(passthroughGain);
  passthroughGain.connect(context.destination);

  // The worklet module has to be registered on this context before a node can
  // reference it. Loaded from the extension's own origin, so no CSP or
  // web_accessible_resources entry is involved.
  await context.audioWorklet.addModule(WORKLET_URL);

  const tap = new AudioWorkletNode(context, "pcm-framer", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    // Shared constants cannot be imported into a worklet, so pass them in.
    processorOptions: {
      targetSampleRate: TARGET_SAMPLE_RATE,
      frameMs: FRAME_MS,
    },
  });
  tap.port.onmessage = (e: MessageEvent<PcmFrameMessage>) => emit(e.data);

  source.connect(tap);
  // The node is pulled by the graph only while it reaches a destination. It
  // writes nothing to its output, so this link carries silence.
  tap.connect(context.destination);

  capture = { stream, context, source, tap, passthroughGain };
  seq = 0;

  connect();
}

function stop(): void {
  if (capture) {
    capture.tap.port.onmessage = null;
    capture.tap.disconnect();
    capture.source.disconnect();
    capture.stream.getTracks().forEach((t) => t.stop());
    if (capture.context.state !== "closed") void capture.context.close();
    capture = null;
  }
  disconnect();
}

// ── Framing ─────────────────────────────────────────────────────────────────────
// Resampling and framing happen on the audio thread (see pcm-worklet.ts); this
// side only forwards finished frames. Frames are contiguous and non-overlapping
// — a streaming ASR keeps state across them, so overlap would double-count.

function emit(frame: PcmFrameMessage): void {
  const open = streaming && socket?.readyState === WebSocket.OPEN;
  if (open) socket!.send(frame.pcm.buffer);

  void chrome.runtime.sendMessage({
    type: "AUDIO_CHUNK",
    stats: {
      seq: seq++,
      sampleRate: TARGET_SAMPLE_RATE,
      samples: frame.samples,
      durationMs: FRAME_MS,
      rms: frame.rms,
      sent: open,
    },
  } satisfies ExtensionMessage);
}

// ── WebSocket ───────────────────────────────────────────────────────────────────

function connect(): void {
  if (!endpoint) return;
  try {
    // `language` is read at dial time, not captured at start, so a reconnect
    // after the user changed language in settings carries the NEW choice.
    socket = new WebSocket(wsUrlForLanguage(endpoint, language));
    socket.binaryType = "arraybuffer";
  } catch (err) {
    scheduleReconnect();
    reportError(err);
    return;
  }

  socket.addEventListener("open", () => {
    backoff = 1000;
    setCloudStatus(true);
    // Redundant with the ?language= on the URL, and deliberately kept: it costs
    // one small DynamoDB write per connection (not per frame) and guarantees
    // the session ends up on the user's choice even if the query string is
    // stripped in transit or $connect fell back to its default.
    sendControl({ action: "setLanguage", language });
  });

  socket.addEventListener("message", (e) => handleCloudMessage(e.data));

  socket.addEventListener("close", () => {
    setCloudStatus(false);
    if (capture) scheduleReconnect(); // only retry while still capturing
  });

  socket.addEventListener("error", () => {
    // 'close' fires after 'error'; reconnect is scheduled there.
    socket?.close();
  });
}

function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  if (socket) {
    socket.onclose = null; // avoid triggering reconnect on intentional close
    socket.close();
    socket = null;
  }
  setCloudStatus(false);
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = self.setTimeout(() => {
    reconnectTimer = undefined;
    if (capture) connect();
  }, backoff);
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
}

function sendControl(message: ClientControlMessage): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function handleCloudMessage(data: unknown): void {
  if (typeof data !== "string") return; // results are JSON; ignore binary echoes
  let parsed: CloudResponse;
  try {
    parsed = JSON.parse(data) as CloudResponse;
  } catch {
    return;
  }

  if (parsed.type === "transcript") {
    void chrome.runtime.sendMessage({
      type: "TRANSCRIPT",
      text: parsed.text,
      isFinal: parsed.isFinal,
    } satisfies ExtensionMessage);
  } else if (parsed.type === "signId") {
    void chrome.runtime.sendMessage({
      type: "SIGN_ID",
      id: parsed.id,
      at: parsed.at,
    } satisfies ExtensionMessage);
  } else if (parsed.type === "error") {
    reportError(new Error(parsed.message));
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function setCloudStatus(connected: boolean): void {
  void chrome.runtime.sendMessage({
    type: "CLOUD_STATUS",
    connected,
  } satisfies ExtensionMessage);
}




function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  void chrome.runtime.sendMessage({
    type: "CAPTURE_STATE",
    active: false,
    error: message,
  } satisfies ExtensionMessage);
}
