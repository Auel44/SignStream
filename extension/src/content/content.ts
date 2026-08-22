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
      void playSign(message.id, message.at);
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
async function playSign(signId: string, at?: number): Promise<void> {
  if (!avatar) return;
  const clip = await loadSignClip(signId, settings);
  if (!avatar) return; // capture may have stopped while we were fetching
  // `at` is present only on the caption path: the media time these words are
  // spoken. Passing it through lets the avatar hold the sign until the video
  // reaches that moment instead of playing it the instant it arrives.
  if (clip) avatar.enqueueClip(clip, at);
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
      void chrome.runtime.sendMessage({
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
  captions = startCaptions(videoSync?.mediaElement ?? null, (cue) => {
    void chrome.runtime.sendMessage({
      type: "MAP_TEXT",
      text: cue.text,
      at: cue.startTime,
    } satisfies ExtensionMessage);
  });

  const live = videoSync?.isLive ?? false;
  // Captions on a live stream carry no lookahead — they are produced as the
  // broadcast happens — so they do not remove the need for ASR the way a
  // recording's track does.
  const captionsCoverIt = captions.source !== "none" && captions.lookahead && !live;
  setAudioStreaming(!captionsCoverIt);

  mode = live
    ? "live-asr"
    : captionsCoverIt
      ? "captions"
      : captions.source !== "none"
        ? "captions-live"
        : "recorded-asr";

  console.debug(
    `[SignStream] source=${mode} live=${live} captions=${captions.source}` +
      ` lookahead=${captions.lookahead} audioStreaming=${!captionsCoverIt}`,
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

function setAudioStreaming(on: boolean): void {
  void chrome.runtime.sendMessage({
    type: "SET_AUDIO_STREAMING",
    enabled: on,
  } satisfies ExtensionMessage);
}

function hide(): void {
  captions?.stop();
  captions = null;
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
      void chrome.runtime.sendMessage({ type: "MEDIA_STARTED" } satisfies ExtensionMessage);
    },
    onMediaIdle: () => {
      void chrome.runtime.sendMessage({ type: "MEDIA_IDLE" } satisfies ExtensionMessage);
    },
  });
}

function stopDetector(): void {
  detector?.detach();
  detector = null;
}

// Pull settings once at injection so the detector can arm itself on a page the
// user opens long after installing.
void chrome.runtime
  .sendMessage({ type: "GET_SETTINGS" })
  .then((res: ExtensionMessage | undefined) => {
    if (res?.type === "SETTINGS") {
      settings = res.settings;
      updateDetector();
    }
  })
  .catch(() => {
    // Service worker asleep or extension reloading — the next SETTINGS
    // broadcast will arm the detector instead.
  });
