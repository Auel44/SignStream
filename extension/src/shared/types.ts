// Shared contracts used across the popup, service worker, and (later) content/offscreen.
// Keeping these in one place is part of the loose-coupling design: each context depends
// on the contract, not on another context's implementation.

/**
 * Sign languages the user can choose.
 *
 * BSL is absent by design, not by oversight. No public BSL keypoint dataset
 * exists to convert, so the dictionary holds a single placeholder clip —
 * offering it would show a Deaf user an avatar that stands still through every
 * sentence. The backend rejects it at the same time (see
 * signstream_common.messages), so the two cannot drift.
 */
export type SignLanguage = "ASL" | "GhSL";

export const SIGN_LANGUAGES: {
  value: SignLanguage;
  /** Full name shown in the picker. */
  label: string;
  /** Where the language is used — the picker's secondary line. */
  region: string;
}[] = [
  { value: "ASL", label: "American Sign Language", region: "United States · Canada" },
  { value: "GhSL", label: "Ghanaian Sign Language", region: "Ghana · West Africa" },
];

/** The four corners the interpreter overlay can sit in. */
export type AvatarPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type AvatarSize = "small" | "medium" | "large";

/**
 * Backdrop treatment behind the signer. Handshapes have to stay legible over
 * arbitrary video, so the avatar always sits on a plain backdrop — this picks
 * which one.
 */
export type AvatarContrast = "standard" | "high" | "inverted";

/**
 * The plate the signer is drawn on. `none` renders the avatar directly over the
 * video with no plate at all.
 */
export type AvatarBackdrop = "studio" | "light" | "dark" | "none";

export interface ExtensionSettings {
  /** Master on/off for the one-way audio→sign pipeline. */
  enabled: boolean;
  /** Active target sign language. */
  language: SignLanguage;
  /** Show the live transcript alongside the avatar. */
  showTranscript: boolean;
  /** Corner the avatar overlay sits in. */
  avatarPosition: AvatarPosition;
  /**
   * Free position set by dragging the avatar. `null` falls back to the corner.
   *
   * Stored as fractions (0–1) of the *free space* — the viewport minus the
   * avatar's own size — rather than pixels. Pixels would put the avatar
   * off-screen on a smaller window, and would be wrong the moment the video
   * goes fullscreen (where the avatar also scales up). Fractions keep the
   * placement proportional and always on-screen: 0 is flush left/top, 1 is
   * flush right/bottom, whatever the viewport.
   */
  avatarCustomPosition: { x: number; y: number } | null;
  /** Avatar overlay size. */
  avatarSize: AvatarSize;
  /** Backdrop treatment behind the signer. */
  avatarContrast: AvatarContrast;
  /** The plate the signer is drawn on. */
  avatarBackdrop: AvatarBackdrop;
  /**
   * Which rigged model signs. Ids come from content/rigs.ts.
   *
   * Everything a model needs — file name and the keypoint-to-bone mapping — is
   * data in that file, so adding an avatar is a new entry there plus the model
   * in public/ and manifest.json's web_accessible_resources. No renderer
   * changes. All twelve shipped rigs are .vrm, where bone identity comes from
   * the file's own humanoid and no name table is needed.
   */
  avatarModel: string;
  /** Begin signing as soon as audio is detected on a stream. */
  autoStart: boolean;
  /**
   * Whether the captured tab audio is played back through the speakers.
   *
   * `chrome.tabCapture` *removes* the tab's audio from the normal output and
   * hands it to us, so the tab is silent unless we explicitly route it to the
   * speakers again. That makes this a genuine either/or:
   *
   *   true  — we forward the audio on, so hearing users in the room still hear
   *           the video while the avatar signs it.
   *   false — the audio goes to transcription only and never reaches the
   *           speakers. Useful for a Deaf user who does not want to broadcast
   *           sound they cannot hear, or in a shared/quiet space.
   *
   * Either way the same audio reaches the cloud — this changes nothing about
   * transcription, only what the room hears.
   */
  audioPassthrough: boolean;
  /** Soften the video directly behind the signer for clarity. */
  dimBackground: boolean;
  /**
   * Signing playback rate (1 = the pace the clips were recorded at).
   *
   * Defaults slightly fast on purpose. The recordings are isolated citation
   * forms — each performed slowly and clearly on its own — whereas connected
   * signing runs quicker. A modest lift stays comfortably readable and buys
   * real throughput against an avatar that is otherwise slower than speech.
   */
  signingSpeed: number;
  /** Set once the first-run wizard has been completed. */
  onboarded: boolean;
  /**
   * True once the user has *explicitly* picked a sign language.
   *
   * Separate from `language` because `language` always holds a usable value —
   * it cannot be empty without breaking every consumer. Without this flag a
   * preselected radio button would be indistinguishable from a deliberate
   * choice, and a Deaf user could be shown ASL purely because they clicked
   * Continue quickly. The wizard blocks on this.
   */
  languageChosen: boolean;

  // ── Backend endpoints ───────────────────────────────────────────────────
  // Kept in settings rather than hard-coded so a build can be pointed at a
  // local dev backend or a deployed stack without recompiling. Empty means
  // "use the compiled-in default" (see shared/config.ts).

  /** wss:// URL of the API Gateway WebSocket. Empty = compiled-in default. */
  wsEndpoint: string;
  /** Base URL clips are fetched from (S3/CloudFront). Empty = compiled-in default. */
  dictionaryBaseUrl: string;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: false,
  language: "ASL",
  showTranscript: true,
  avatarPosition: "bottom-right",
  avatarCustomPosition: null,
  avatarSize: "medium",
  avatarContrast: "standard",
  avatarBackdrop: "studio",
  avatarModel: "vrm1",
  autoStart: true,
  // Default to hearing the audio: it matches what the tab did before the
  // extension was installed, so enabling SignStream never silently mutes a
  // video for anyone else in the room.
  audioPassthrough: true,
  dimBackground: false,
  // 1.0 = the pace the clip was recorded at. It defaulted to 1.2 — a fifth
  // faster than a citation form is already signed — which read as rushed and
  // gave a viewer no room to read a handshape before the next sign arrived.
  // Faster is available on the slider for anyone who wants it; it is not a
  // sensible thing to impose on a first-time viewer.
  signingSpeed: 1,
  onboarded: false,
  languageChosen: false,
  wsEndpoint: "",
  dictionaryBaseUrl: "",
};

// ── Audio capture constants ─────────────────────────────────────────────────────
// 16 kHz mono is the standard input rate for the ASR models (Moonshine /
// Parakeet). Frames sent to the cloud are CONTIGUOUS (no overlap): a streaming ASR
// keeps internal state across frames, so overlapping audio would double-count and
// harm transcription. 250 ms sits within the proposal's 200–500 ms guidance (§5.2).

export const TARGET_SAMPLE_RATE = 16000;
export const FRAME_MS = 250;

/** Lightweight description of one captured audio frame (for the popup meter). */
export interface AudioChunkStats {
  /** Monotonic sequence number since capture started. */
  seq: number;
  sampleRate: number;
  /** Number of PCM samples in the frame. */
  samples: number;
  durationMs: number;
  /** Root-mean-square level (0–1), useful as a quick "is there audio" meter. */
  rms: number;
  /** Whether this frame was sent to the cloud (false if the socket was down). */
  sent: boolean;
}

// ── Cloud wire protocol (extension ↔ API Gateway WebSocket) ───────────────────────
// Mirrored on the backend. Control messages are JSON; audio frames are binary
// (Int16 little-endian PCM) sent as raw WebSocket binary frames.

export type ClientControlMessage =
  | { action: "setLanguage"; language: SignLanguage }
  /**
   * Map caption text to signs without sending any audio.
   *
   * `at` is the media time the words are spoken; the backend echoes it back on
   * every resulting signId so the client can schedule the sign for exactly
   * that moment instead of playing it on arrival.
   */
  | { action: "mapText"; text: string; at: number };

export type CloudResponse =
  | { type: "ready" }
  | { type: "transcript"; text: string; isFinal: boolean }
  | { type: "signId"; id: string; at?: number; fingerspell?: boolean }
  | { type: "error"; message: string };

// ── Diagnostics ─────────────────────────────────────────────────────────────
// What the pipeline is actually doing, surfaced in the popup.
//
// This exists because a silent avatar has too many indistinguishable causes:
// capture never started, the socket is down, the words matched no sign, the
// clip 404'd, or the model failed to load. All of them look like "the avatar is
// broken", and chasing them from a blank rectangle means guessing. Each stage
// reports here instead, so the failing one names itself.

/** Content-script half of the readout. Null when no overlay is mounted. */
export interface AvatarStatus {
  /** The rig the overlay was built for. */
  rigId: string;
  /** False while the glTF is still loading, or if it failed. */
  rigLoaded: boolean;
  /** Set when the model could not be loaded at all. */
  rigError: string | null;
  /** Bones the retargeter actually drives, and mapped bones it could not find. */
  bonesDriven: number;
  bonesMissing: number;
  /** Sign ids that resolved to a clip, and ones that had none. */
  clipsPlayed: number;
  clipsMissing: number;
  /** Whether the host media is currently producing audio. */
  playing: boolean;
  /** Signs waiting to be performed. */
  queued: number;
}

/** Assembled by the service worker from every context's reports. */
export interface Diagnostics {
  captureActive: boolean;
  captureError?: string;
  /**
   * A capture that is running but producing nothing usable — the tab is muted,
   * or the stream carries no audio. Distinct from `captureError`, which means
   * capture is dead: this one stays live and may recover on its own.
   */
  captureWarning?: string;
  cloudConnected: boolean;
  /** Audio frames captured, and how many actually reached the cloud. */
  audioFrames: number;
  audioSent: number;
  /** Level of the most recent frame — near zero means silence is being captured. */
  lastRms: number;
  /**
   * How long the capture has been returning pure digital silence.
   *
   * Not the same as a quiet passage: this counts frames whose every sample is
   * exactly zero, which real audio essentially never is. Sustained non-zero
   * here is the signature of a stream that is connected but carries nothing.
   */
  audioSilentMs: number;
  transcripts: number;
  lastTranscript: string;
  signIds: number;
  lastSignId: string;
  /**
   * Whether the last relay to the captured tab was delivered.
   *
   * False means no content script is listening there, so sign ids are being
   * emitted into nothing. Every other stage still reports healthy in that
   * state, which is exactly why it needs its own line.
   */
  contentReachable: boolean;
  avatar: AvatarStatus | null;
}

// ── Messages between extension contexts ─────────────────────────────────────────
// A small, explicit message union. Each context handles only the variants it owns.

export type ExtensionMessage =
  // settings (popup ↔ service worker)
  | { type: "GET_SETTINGS" }
  | { type: "SETTINGS"; settings: ExtensionSettings }
  | { type: "SAVE_SETTINGS"; patch: Partial<ExtensionSettings> }
  // capture control (popup → service worker)
  | { type: "START_CAPTURE"; tabId: number }
  | { type: "STOP_CAPTURE" }
  | { type: "GET_CAPTURE_STATE" }
  // the page started playing media (content → service worker); drives auto-start
  | { type: "MEDIA_STARTED" }
  // every media element on the page stopped (content → service worker)
  | { type: "MEDIA_IDLE" }
  // capture state broadcast (service worker → popup)
  | { type: "CAPTURE_STATE"; active: boolean; error?: string }
  // offscreen control (service worker → offscreen)
  | {
      type: "OFFSCREEN_START";
      streamId: string;
      language: SignLanguage;
      wsEndpoint: string;
      audioPassthrough: boolean;
    }
  | { type: "OFFSCREEN_STOP" }
  /**
   * Readiness probe for a freshly created offscreen document.
   *
   * `chrome.offscreen.createDocument()` resolves when the document exists, not
   * when its script has run — so an OFFSCREEN_START sent immediately after can
   * land before the listener is registered and be dropped silently, leaving
   * capture "active" with no audio ever captured. The service worker pings
   * until this is answered before sending anything that matters.
   */
  | { type: "OFFSCREEN_PING" }
  | { type: "OFFSCREEN_READY" }
  /** Capture is live but producing nothing usable (offscreen → service worker). */
  | { type: "CAPTURE_WARNING"; message: string | null }
  | { type: "OFFSCREEN_SET_LANGUAGE"; language: SignLanguage }
  | { type: "OFFSCREEN_SET_PASSTHROUGH"; audioPassthrough: boolean }
  // audio frame report (offscreen → service worker)
  | { type: "AUDIO_CHUNK"; stats: AudioChunkStats }
  // cloud connection state (offscreen → service worker → popup)
  | { type: "CLOUD_STATUS"; connected: boolean }
  // results coming back from the cloud (offscreen → service worker → popup/content)
  | { type: "TRANSCRIPT"; text: string; isFinal: boolean }
  /**
   * `fingerspell` marks one letter of a spelled word. Letters are read as a
   * continuous run, not as separate signs, so the avatar plays them faster.
   */
  | { type: "SIGN_ID"; id: string; at?: number; fingerspell?: boolean }
  // caption cue text to be mapped to signs (content → service worker → offscreen)
  | { type: "MAP_TEXT"; text: string; at: number }
  | { type: "OFFSCREEN_MAP_TEXT"; text: string; at: number }
  /**
   * Suppress or resume uploading audio frames to the cloud.
   *
   * Capture keeps running regardless — it is what feeds the tab's audio back
   * to the speakers. This only controls whether frames are sent for
   * transcription, which is skipped entirely when a caption track already
   * supplies the words.
   */
  | { type: "SET_AUDIO_STREAMING"; enabled: boolean }
  | { type: "OFFSCREEN_SET_STREAMING"; enabled: boolean }
  /**
   * Fetch a clip on the content script's behalf.
   *
   * The content script cannot fetch the dictionary itself. Its `fetch` carries
   * the PAGE's origin, so a clip on `http://localhost:8081` is a request from
   * `https://www.youtube.com` into the loopback address space, which Chrome
   * blocks outright:
   *
   *   "blocked by CORS policy: Permission was denied for this request to
   *    access the `loopback` address space."
   *
   * Every clip failed that way, so the avatar had nothing to play. The service
   * worker has the extension's own origin and host permissions, and is not
   * subject to the page's rules — so the fetch moves there and the bytes come
   * back over the message channel.
   */
  | { type: "FETCH_CLIP"; url: string }
  /** `status` is the HTTP status, or 0 when the request never completed. */
  | { type: "CLIP_DATA"; status: number; body: unknown }
  // diagnostics (popup → service worker → content, and back)
  | { type: "GET_DIAGNOSTICS" }
  | { type: "DIAGNOSTICS"; diagnostics: Diagnostics }
  | { type: "GET_AVATAR_STATUS" }
  | { type: "AVATAR_STATUS"; status: AvatarStatus | null };

// ── Sign dictionary clips ───────────────────────────────────────────────────
// Produced by pose-generator/ and served from S3/CloudFront. One clip per sign;
// the avatar replays `frames` in order to perform it. Mirrors the schema in
// dictionary/README.md.

/** One frame: a position per entry in the clip's `joints` array. */
export interface SignClipFrame {
  /** Milliseconds from the start of the clip. */
  t: number;
  /** `[x, y, z]` per joint, body-relative metres, Y-up. `[0,0,0]` = not tracked. */
  positions: [number, number, number][];
}

export interface SignClip {
  schemaVersion: number;
  /** e.g. `ghsl-hello-v1` — matches the id the backend pushes. */
  signId: string;
  gloss: string;
  language: string;
  durationMs: number;
  fps: number;
  /**
   * How the keypoints were obtained.
   *
   * Every clip in the dictionary is currently `openpose-2d`, which matters at
   * playback: a 2D source records no depth, so `z` is 0 on every keypoint and
   * the avatar has to be given a front-to-back profile or it signs inside its
   * own chest. See `addSigningDepth`. A clip from a 3D source carries real
   * depth and must be left alone, so the distinction is recorded rather than
   * assumed.
   *
   * Optional because older clips may predate the field; absent is treated as
   * "not flat", so nothing is silently altered.
   */
  source?: "openpose-2d" | string;
  /** Ordered joint names; indexes line up with each frame's `positions`. */
  joints: string[];
  frames: SignClipFrame[];
  /**
   * Sign id this clip was copied from, when it is not an original recording.
   *
   * Set only for the manual alphabet. GhSL inherited its fingerspelling from
   * ASL via Andrew Foster in 1957, so the letter handshapes genuinely are the
   * same and the ASL letter clips are the correct data rather than a stand-in.
   * Lexical signs are never shared this way.
   *
   * Recorded so the provenance survives in the file: without it these are
   * indistinguishable from clips recorded by a Ghanaian signer, and a later
   * reader would have no reason to check.
   */
  derivedFrom?: string;
  /** Human-readable reason for `derivedFrom`. */
  derivedNote?: string;
}
