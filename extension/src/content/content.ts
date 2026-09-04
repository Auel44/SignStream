// Content script: mounts the avatar overlay on the page, keeps it in step with
// the page's media, and renders results relayed from the service worker.
//
// Two responsibilities:
//   1. While capture is active — draw the avatar and follow playback exactly
//      (pause, seek, rate, buffering, source change).
//   2. Even while dormant — notice when the page starts playing media, so the
//      service worker can auto-start capture without the user opening the popup.

import { Overlay } from "./overlay";
import { Avatar } from "./avatar";
import { VideoSync } from "./video-sync";
import { loadSignClip } from "./sign-clips";
import { rigById } from "./rigs";
import { startCaptions, type CaptionFeed } from "./captions";
import {
  DEFAULT_SETTINGS,
  type ExtensionMessage,
  type ExtensionSettings,
} from "../shared/types";

let overlay: Overlay | null = null;
let avatar: Avatar | null = null;
let videoSync: VideoSync | null = null;
let settings: ExtensionSettings = DEFAULT_SETTINGS;

/** A separate watcher that runs while capture is OFF, purely to spot playback. */
let detector: VideoSync | null = null;
/** Caption feed, when the page has one. Non-null means ASR is not needed. */
let captions: CaptionFeed | null = null;
/** Which strategy is supplying words. Surfaced for diagnosis. */
let mode: "captions" | "captions-live" | "recorded-asr" | "live-asr" = "recorded-asr";
/** Signs that arrived before any avatar existed. Non-zero is always a fault. */
let signsDroppedNoAvatar = 0;

// ── Orphaned content scripts ────────────────────────────────────────────────
//
// Reloading, updating or disabling the extension destroys the context this
// script belongs to, but NOT the script: Chrome leaves it running in every
// page that was already open. It keeps its timers, its observers and the
// avatar's requestAnimationFrame loop, but every `chrome.*` call it makes now
// throws "Extension context invalidated".
//
// Left alone that is not a cosmetic problem. The render loop carries on
// driving WebGL on a page whose overlay can never receive another sign, and
// each media event throws again, so the page's console fills with an error
// naming a line inside bundled three.js — which reads like a rendering bug and
// is nothing of the kind.
//
// So it is detected and shut down once, quietly. Reloading the page is what
// brings the overlay back, and the message says so.

// First line out of the content script, so "is the page running the build I
// just made?" is answerable at a glance rather than inferred from a stack.
console.info(`[SignStream] content script build ${__BUILD_STAMP__}`);

/** True while this script still belongs to a live extension. */
function extensionAlive(): boolean {
  try {
    // Reading `id` off an invalidated runtime yields undefined rather than
    // throwing, but the whole object can be gone, so it is still guarded.
    return chrome.runtime?.id !== undefined;
  } catch {
    return false;
  }
}

let orphaned = false;

/** Tear everything down for good. Idempotent — several paths can notice. */
function shutdownOrphan(): void {
  if (orphaned) return;
  orphaned = true;
  try {
    captions?.stop();
    captions = null;
    window.clearTimeout(captionSilence);
    videoSync?.detach();
    videoSync = null;
    avatar?.clearQueue();
    avatar?.stop();
    overlay?.unmount();
    // Deliberately NOT via hide(): that ends by restarting the detector, which
    // is exactly the loop an orphan must not keep running.
    detector?.detach();
    detector = null;
    clearInterval(orphanWatch);
  } catch {
    // Teardown is best-effort. Nothing here can be retried, and throwing would
    // only add another uncatchable error to the page.
  }
  console.info(
    "[SignStream] The extension was reloaded, so this page's interpreter has " +
      "been disconnected. Reload the page to bring it back.",
  );
}

/**
 * Fire-and-forget message to the service worker.
 *
 * Every send site went through `void chrome.runtime.sendMessage(...)`, which
 * throws synchronously on an invalidated context and rejects when the service
 * worker is merely asleep. Both are handled here so no caller has to.
 */
function notify(message: ExtensionMessage): void {
  if (orphaned) return;
  if (!extensionAlive()) {
    shutdownOrphan();
    return;
  }
  try {
    void chrome.runtime.sendMessage(message).catch(() => {
      // A dropped message to a sleeping worker is normal and not worth a log.
      if (!extensionAlive()) shutdownOrphan();
    });
  } catch {
    shutdownOrphan();
  }
}

/**
 * Notice orphaning even when nothing is being sent.
 *
 * `notify` only detects it when the page happens to emit a media event. A
 * video that is simply playing emits none, so without this the render loop
 * would carry on driving WebGL on a dead overlay for as long as the tab stayed
 * open. Five seconds is far below what a person would notice and costs a
 * property read; the interval clears itself the moment it fires.
 */
const orphanWatch = setInterval(() => {
  if (!extensionAlive()) {
    clearInterval(orphanWatch);
    shutdownOrphan();
  }
}, 5000);

chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  switch (message.type) {
    case "CAPTURE_STATE":
      if (message.active) void show();
      else hide();
      break;
    case "SETTINGS":
      settings = message.settings;
      // `enabled` is the Connect/Disconnect switch, and it governs the avatar
      // directly rather than only through CAPTURE_STATE. Acting on it here
      // means the interpreter disappears the moment the user disconnects, even
      // if the capture-state broadcast is delayed or lost — the switch is never
      // left looking like it did nothing.
      if (!settings.enabled) {
        hide();
        break;
      }
      overlay?.applySettings(settings);
      avatar?.setSpeed(settings.signingSpeed);
      avatar?.resize();
      // Switching model means a different skeleton and a different bone map,
      // so the avatar is rebuilt rather than mutated.
      //
      // Compared against the RESOLVED rig, not the raw setting. An id that no
      // longer exists resolves to the fallback rig, so comparing the raw string
      // would never match what was actually built and would rebuild the avatar
      // on every settings broadcast.
      if (avatar && avatar.rigId !== rigById(settings.avatarModel).id) {
        avatar.stop();
        avatar = null;
        void show();
        break;
      }
      updateDetector();
      break;
    case "TRANSCRIPT":
      if (settings.showTranscript) overlay?.setCaption(message.text);
      break;
    case "SIGN_ID":
      void playSign(message.id, message.at, message.fingerspell);
      break;
  }
});

// Answered separately from the switch above because it must reply. The listener
// above returns nothing (undefined), which closes the channel immediately; a
// responder has to return `true` to keep it open, so it lives on its own.
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, respond) => {
  if (message.type !== "GET_AVATAR_STATUS") return undefined;
  respond({ type: "AVATAR_STATUS", status: avatar?.getStatus() ?? null });
  return true;
});

/**
 * Resolve a sign id to its clip and hand it to the avatar. The fetch is async,
 * but clips queue in arrival order inside the avatar, so a slow first fetch
 * can't reorder a sentence.
 */
async function playSign(
  signId: string,
  at?: number,
  fingerspell?: boolean,
): Promise<void> {
  if (!avatar) {
    // Reaching here means signs are arriving for a page with no mounted
    // interpreter. Recoverable — ask for the capture state that built no
    // avatar and mount now — but say so either way: this used to be a bare
    // `return`, which discarded every sign of the session without a trace.
    signsDroppedNoAvatar += 1;
    console.warn(
      `[SignStream] sign ${signId} arrived with no avatar mounted ` +
        `(${signsDroppedNoAvatar} dropped) — mounting now`,
    );
    void show();
    return;
  }
  const clip = await loadSignClip(signId, settings);
  if (!avatar) return; // capture may have stopped while we were fetching
  // `at` is present only on the caption path: the media time these words are
  // spoken. Passing it through lets the avatar hold the sign until the video
  // reaches that moment instead of playing it the instant it arrives.
  if (clip) avatar.enqueueClip(clip, at, fingerspell);
  else avatar.playPlaceholder();
}

// ── Active state (capture on) ────────────────────────────────────────────────

async function show(): Promise<void> {
  // Refresh settings, but never let this block the avatar appearing. The
  // service worker can be mid-restart, and an unhandled rejection here used to
  // mean capture was live with no interpreter on screen and no error anywhere.
  try {
    const res = (await chrome.runtime.sendMessage({
      type: "GET_SETTINGS",
    })) as ExtensionMessage | undefined;
    if (res?.type === "SETTINGS") settings = res.settings;
  } catch {
    // Fall through with the settings we already have.
  }

  // The dormant detector is redundant once the real sync is running.
  stopDetector();

  if (!overlay) overlay = new Overlay();
  overlay.mount(
    settings,
    // The overlay re-lays-itself-out on fullscreen and window resize; the
    // avatar has to rebuild its canvas backing store or it renders blurry.
    () => avatar?.resize(),
    // Persist a drag. Written once on release rather than per pointermove —
    // chrome.storage.sync is rate-limited, and a drag would blow through the
    // write quota in a second.
    (avatarCustomPosition) => {
      settings = { ...settings, avatarCustomPosition };
      notify({
        type: "SAVE_SETTINGS",
        patch: { avatarCustomPosition },
      } satisfies ExtensionMessage);
    },
  );

  if (!avatar) avatar = new Avatar(overlay.canvas, settings.avatarModel);
  avatar.setErrorHandler((message) => overlay?.setError(message));
  avatar.setSpeed(settings.signingSpeed);
  avatar.resize();
  avatar.start();

  if (!videoSync) videoSync = new VideoSync();
  // Judge sign staleness against the video's own clock, so it stays correct
  // across pause and seek rather than drifting with wall-clock time.
  avatar.setMediaClock(() => videoSync?.currentTime ?? 0);
  videoSync.attach({
    onState: ({ playing, playbackRate }) => {
      avatar?.setPlaying(playing);
      avatar?.setPlaybackRate(playbackRate);
      // `duration` is NaN until metadata loads and a caption track can appear
      // only once the user enables subtitles, so the live/captions decision
      // has to be revisited rather than made once at start.
      if (playing) reconsiderSource();
    },
    // Seek, source change or end: queued signs describe audio the user is no
    // longer at, so drop them rather than sign the wrong words.
    onFlush: () => avatar?.clearQueue(),
  });

  startCaptionFeed();
}

/**
 * Choose how this video gets its words, and tell the backend.
 *
 * Three cases, in the order they are preferred:
 *
 *   1. Pre-recorded WITH captions — the transcript already exists, with
 *      timings. Every sign is scheduled for the exact moment its words are
 *      spoken, so it is genuinely in sync rather than trailing. Audio is not
 *      streamed at all: no ASR cost, no bandwidth, and better text than a
 *      small model produces.
 *   2. Pre-recorded WITHOUT captions — Moonshine transcribes the audio. Signs
 *      follow a beat behind, bounded by the avatar's expiry rule.
 *   3. Live — nothing has been said yet, so there is nothing to read ahead.
 *      Moonshine again, and "in sync" is not achievable by anyone: you cannot
 *      sign a word before it is spoken. Near-real-time is the honest ceiling.
 *
 * Re-evaluated whenever playback state changes, because a caption track can
 * appear late (the user enables subtitles) or stop part-way through.
 */
function startCaptionFeed(): void {
  captions?.stop();
  window.clearTimeout(captionSilence);

  captions = startCaptions(videoSync?.mediaElement ?? null, (cue) => {
    // A cue is proof the caption feed is live, so ASR is redundant for as long
    // as they keep arriving. Both calls are idempotent.
    setAudioStreaming(false);
    armCaptionSilence();
    notify({
      type: "MAP_TEXT",
      text: cue.text,
      at: cue.startTime,
    } satisfies ExtensionMessage);
  });

  const live = videoSync?.isLive ?? false;
  // Captions and ASR describe the SAME audio, so running both signs every
  // sentence twice. Any working caption feed therefore replaces ASR outright.
  //
  // The test used to be `lookahead && !live`, which is the right question for
  // whether a sign can be SCHEDULED ahead of playback but the wrong one for
  // whether captions replace ASR. A DOM-scraped feed has no lookahead and still
  // delivers every word, so both ran permanently: measured on one 13-minute
  // video, 118 utterances came from captions and 62 from ASR, interleaved
  // throughout rather than during a hand-over.
  //
  // `lookahead` still decides `mode` below, because it is what separates a sign
  // scheduled for the moment its words are spoken from one that merely follows.
  const haveCaptions = captions.source !== "none";
  const captionsCoverIt = haveCaptions && captions.lookahead && !live;
  setAudioStreaming(!haveCaptions);
  if (haveCaptions) armCaptionSilence();

  mode = live
    ? "live-asr"
    : captionsCoverIt
      ? "captions"
      : haveCaptions
        ? "captions-live"
        : "recorded-asr";

  console.debug(
    `[SignStream] source=${mode} live=${live} captions=${captions.source}` +
      ` lookahead=${captions.lookahead} scheduled=${captionsCoverIt}` +
      ` audioStreaming=${!haveCaptions}`,
  );
}

/**
 * Turn cloud audio streaming on or off without stopping capture.
 *
 * Capture itself must keep running even when captions supply the words: it is
 * what routes the tab's audio back to the speakers (tabCapture removes it
 * otherwise), and what the playback detector relies on. Only the upload is
 * suppressed — which is the part that costs bandwidth and inference.
 */
/**
 * Re-run the routing decision if anything relevant has changed.
 *
 * Cheap and idempotent: a caption track that appears mid-video (the user turns
 * subtitles on) or a `duration` that only resolves after metadata loads both
 * change the answer, and neither fires a dedicated event.
 */
function reconsiderSource(): void {
  const live = videoSync?.isLive ?? false;
  const expected = live ? "live-asr" : captions?.lookahead ? "captions" : mode;
  if (expected !== mode || captions?.source === "none") startCaptionFeed();
}

/**
 * Whether audio is currently being uploaded for transcription.
 *
 * Mirrors what the offscreen document was last told, so repeating a decision
 * costs nothing — the cue handler calls this on every caption line.
 */
let asrStreaming = true;

function setAudioStreaming(on: boolean): void {
  if (on === asrStreaming) return;
  asrStreaming = on;
  notify({
    type: "SET_AUDIO_STREAMING",
    enabled: on,
  } satisfies ExtensionMessage);
}

/**
 * How long a caption feed may go quiet before ASR is brought back.
 *
 * Handing the words to captions means nothing is signed at all if that feed
 * stops — the viewer switches subtitles off, the player swaps its caption
 * element, the track ends early. Long enough not to trip on an ordinary pause
 * in speech; short enough that a dead feed does not cost a whole scene. If it
 * fires and captions later resume, the cue handler simply turns ASR off again.
 */
const CAPTION_SILENCE_MS = 15000;
let captionSilence: number | undefined;

function armCaptionSilence(): void {
  window.clearTimeout(captionSilence);
  captionSilence = window.setTimeout(() => {
    console.debug("[SignStream] caption feed went quiet — falling back to ASR");
    setAudioStreaming(true);
  }, CAPTION_SILENCE_MS);
}

function hide(): void {
  captions?.stop();
  captions = null;
  window.clearTimeout(captionSilence);
  // A restarted capture brings up a fresh offscreen document that streams by
  // default, so the mirror has to forget what the old one was told or the next
  // "stop streaming" would be suppressed as a no-op.
  asrStreaming = true;
  videoSync?.detach();
  videoSync = null;
  avatar?.clearQueue();
  avatar?.stop();
  overlay?.unmount();
  updateDetector(); // go back to watching for playback
}

// ── Dormant state (capture off) ──────────────────────────────────────────────

/**
 * Watch for media starting while capture is off, and ask the service worker to
 * begin. Only runs when the user has finished onboarding and left auto-start
 * on — otherwise the extension would try to capture pages it was never
 * pointed at.
 */
function updateDetector(): void {
  // `enabled` is the master switch the popup's Connect/Disconnect button
  // drives. Checking it here means a user who disconnected is not even
  // watched for playback, let alone restarted.
  const wanted =
    settings.enabled && settings.autoStart && settings.onboarded && !videoSync;
  if (wanted) startDetector();
  else stopDetector();
}

function startDetector(): void {
  if (detector) return;
  detector = new VideoSync();
  detector.attach({
    onState: () => {},
    onFlush: () => {},
    onMediaStarted: () => {
      notify({ type: "MEDIA_STARTED" } satisfies ExtensionMessage);
    },
    onMediaIdle: () => {
      notify({ type: "MEDIA_IDLE" } satisfies ExtensionMessage);
    },
  });
}

function stopDetector(): void {
  detector?.detach();
  detector = null;
}

/**
 * Adopt whatever state the extension is already in, at injection time.
 *
 * Settings arm the dormant detector on a page opened long after installing.
 * Capture state matters for a subtler reason: `show()` — the only thing that
 * ever constructs the avatar — runs exclusively in response to a CAPTURE_STATE
 * broadcast. A content script that loads while capture is ALREADY running
 * never sees that broadcast, so `avatar` stays null, and every sign id relayed
 * to it is dropped by `playSign`'s `if (!avatar) return`. No fetch, no error,
 * nothing in any log: the backend transcribes and emits signs perfectly while
 * the page shows no interpreter at all.
 *
 * That is not a rare corner. It is what happens every time the page is
 * reloaded mid-capture, and every time the extension is reloaded during
 * development (which orphans the old content script and leaves the new one
 * loading into a session that is already live).
 *
 * Asking on load makes the overlay self-healing: reload the page and the
 * avatar comes back on its own.
 */
void chrome.runtime
  .sendMessage({ type: "GET_SETTINGS" })
  .then((res: ExtensionMessage | undefined) => {
    if (res?.type === "SETTINGS") {
      settings = res.settings;
      updateDetector();
    }
    // Safe to ask: the service worker only acts on a queued auto-start when
    // the sender is the popup, so this query has no side effect from here.
    return chrome.runtime.sendMessage({ type: "GET_CAPTURE_STATE" });
  })
  .then((res: ExtensionMessage | undefined) => {
    if (res?.type === "CAPTURE_STATE" && res.active && settings.enabled) void show();
  })
  .catch(() => {
    // Service worker asleep or extension reloading — the next SETTINGS
    // broadcast will arm the detector instead.
  });
