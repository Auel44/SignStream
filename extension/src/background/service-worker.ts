// SignStream service worker (MV3 background).
//
// Owns two concerns, kept independent of each other:
//   1. Settings — single source of truth, answered to the popup.
//   2. Capture orchestration — wires the active tab → offscreen document, and
//      tracks capture state. The offscreen doc does the actual Web Audio work;
//      the service worker only coordinates, so neither knows the other's guts.
//
// step 4: results coming back (capture state, settings, transcript, sign IDs)
// are relayed to the captured tab's content script, which draws the avatar
// overlay. The service worker is the only context that can reach a content
// script (via tabs.sendMessage), so it acts as the router.

import {
  DEFAULT_SETTINGS,
  type AvatarStatus,
  type Diagnostics,
  type ExtensionMessage,
  type ExtensionSettings,
} from "../shared/types";
import { resolveWsEndpoint } from "../shared/config";
import { RIGS } from "../content/rigs";

/**
 * Running tally of what each pipeline stage has produced, for the diagnostics
 * page. Module-level on purpose: it is a debugging aid, so losing it when the
 * worker sleeps is acceptable — persisting it to session storage would mean a
 * write on every 250 ms audio frame, which is far too expensive for counters
 * nobody is looking at most of the time.
 */
const pipeline: Omit<Diagnostics, "captureActive" | "avatar"> = {
  cloudConnected: false,
  audioFrames: 0,
  audioSent: 0,
  lastRms: 0,
  audioSilentMs: 0,
  transcripts: 0,
  lastTranscript: "",
  signIds: 0,
  lastSignId: "",
  contentReachable: true,
};

const STORAGE_KEY = "settings";
const OFFSCREEN_PATH = "src/offscreen/offscreen.html";
/** ~1s total. Document creation is fast; this only covers script startup. */
const OFFSCREEN_READY_ATTEMPTS = 20;
const OFFSCREEN_READY_POLL_MS = 50;
/** The popup markup, opened as a full tab for first-run onboarding. */
const ONBOARDING_PATH = "src/popup/index.html";

// ── Capture state ───────────────────────────────────────────────────────────
//
// This state CANNOT live only in module variables. An MV3 service worker is
// terminated after ~30 s idle and restarted on the next event, with all module
// state reset — while the offscreen document keeps capturing, because it has
// its own lifetime. A restarted worker therefore believed nothing was
// capturing, and the next media event started capture *again*: a second
// getUserMedia on a tab already being captured, a second WebSocket, and (the
// symptom that surfaced this) a stream that delivers pure silence, so the
// transcript stopped even though frames kept arriving.
//
// `chrome.storage.session` is the right home: it survives worker restarts,
// lives in memory only, and is cleared when the browser closes — so a crash
// can never leave a stale "capturing" flag behind on disk.

const SESSION_KEY = "captureState";

interface CaptureState {
  active: boolean;
  tabId: number | null;
  /** Tab that asked to auto-start but which Chrome would not let us capture yet. */
  pendingTabId: number | null;
}

const NO_CAPTURE: CaptureState = { active: false, tabId: null, pendingTabId: null };

/** In-memory mirror, so synchronous message handlers can answer immediately. */
let cached: CaptureState = { ...NO_CAPTURE };

async function loadCaptureState(): Promise<CaptureState> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  cached = { ...NO_CAPTURE, ...(stored[SESSION_KEY] ?? {}) };
  return cached;
}

async function setCaptureState(patch: Partial<CaptureState>): Promise<CaptureState> {
  cached = { ...cached, ...patch };
  await chrome.storage.session.set({ [SESSION_KEY]: cached });
  return cached;
}

// Rehydrate as soon as the worker starts, so an event that arrives moments
// later already sees the truth rather than the defaults.
const ready = loadCaptureState();

/**
 * Send a message to the captured tab's content script (best-effort).
 *
 * Awaits `ready` before reading the tab id. The worker is restarted constantly
 * — every sign id can arrive at a cold worker — and rehydrating from
 * storage.session is asynchronous. Reading `cached` synchronously meant the
 * first messages after every restart saw `tabId === null` and were silently
 * dropped, so sign ids never reached the content script and no clip was ever
 * fetched. Awaiting costs nothing once the state is already loaded.
 */
function relayToContent(message: ExtensionMessage): void {
  void ready.then(() => {
    if (cached.tabId === null) return;
    chrome.tabs
      .sendMessage(cached.tabId, message)
      .then(() => {
        pipeline.contentReachable = true;
      })
      .catch(() => {
        // No content script listening on the captured tab. Recording it rather
        // than ignoring it, because this is the state in which the pipeline
        // looks perfect end to end — audio captured, words transcribed, sign
        // ids emitted — while nothing reaches the page and the avatar never
        // appears. Silently swallowing it is what made that indistinguishable
        // from a broken rig or a missing clip.
        //
        // Usually means the page was loaded before the extension (or before it
        // was reloaded), so no content script was ever injected into it.
        pipeline.contentReachable = false;
      });
  });
}

/**
 * Is the offscreen document actually capturing right now?
 *
 * The stored flag is a fast path; this is the authority. If the offscreen
 * document is gone (extension reloaded, Chrome reclaimed it) then nothing is
 * capturing no matter what the flag says, and a stale flag would otherwise
 * block the user from ever starting again.
 */
async function offscreenExists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return contexts.length > 0;
}

// ── Settings ────────────────────────────────────────────────────────────────────

async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const settings: ExtensionSettings = {
    ...DEFAULT_SETTINGS,
    ...(stored[STORAGE_KEY] ?? {}),
  };

  // Drop an avatar id that no longer exists. Retiring a rig leaves every
  // existing install pointing at it, and the stale value does not fail
  // loudly: `rigById` quietly falls back to the first rig, so the model
  // loads while the settings picker shows nothing selected — and, worse, the
  // content script compares the stored id against the id of the rig it
  // actually built, never gets a match, and tears the avatar down and
  // rebuilds it on every settings broadcast.
  if (!RIGS.some((rig) => rig.id === settings.avatarModel)) {
    settings.avatarModel = DEFAULT_SETTINGS.avatarModel;
  }

  return settings;
}

async function saveSettings(
  patch: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  if (!stored[STORAGE_KEY]) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: DEFAULT_SETTINGS });
  }

  // Show onboarding immediately on a fresh install rather than waiting for the
  // user to discover the toolbar icon. Opened as a tab, not the popup — an
  // extension cannot programmatically open its own popup, and a tab survives
  // the focus changes the permission prompt causes.
  //
  // Only on "install": an update or a browser restart must not re-interrupt
  // someone who has already been through it.
  const settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY] ?? {}) };
  if (details.reason === "install" && !settings.onboarded) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(ONBOARDING_PATH) });
  }
});

// ── Offscreen document lifecycle ─────────────────────────────────────────────────

async function ensureOffscreenDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Capture tab audio for real-time speech-to-sign interpretation.",
  });
  await waitForOffscreen();
}

/**
 * Block until the offscreen document is listening.
 *
 * `createDocument()` resolves when the document exists — not when its module
 * has executed and registered `onMessage`. Sending OFFSCREEN_START into that
 * window loses it outright: no error is raised anywhere, capture state reads
 * "active", and not one audio frame is ever captured. It only bites on the
 * first capture after the worker wakes, which is exactly when it is hardest to
 * reproduce and easiest to blame on something else.
 */
async function waitForOffscreen(): Promise<void> {
  for (let attempt = 0; attempt < OFFSCREEN_READY_ATTEMPTS; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: "OFFSCREEN_PING",
      } satisfies ExtensionMessage);
      if ((res as ExtensionMessage | undefined)?.type === "OFFSCREEN_READY") return;
    } catch {
      // "Receiving end does not exist" — the script has not run yet. Retry.
    }
    await new Promise((r) => setTimeout(r, OFFSCREEN_READY_POLL_MS));
  }
  // Fall through rather than throw: a capture attempt that might work is better
  // than a guaranteed failure, and a dropped START now surfaces as the silence
  // warning instead of passing silently.
  console.warn("[SignStream] offscreen document did not answer readiness ping");
}

// ── Capture orchestration ────────────────────────────────────────────────────────

function broadcastCaptureState(active: boolean, error?: string): void {
  void setCaptureState({ active });
  const message = { type: "CAPTURE_STATE", active, error } satisfies ExtensionMessage;
  // The popup may be closed and the offscreen document may not exist yet;
  // either makes this reject with "receiving end does not exist". Harmless,
  // but it must be caught or it surfaces as an unhandled rejection every time.
  chrome.runtime.sendMessage(message).catch(() => {});
  relayToContent(message); // content overlay (show/hide)
}

async function startCapture(tabId: number): Promise<void> {
  await ready;
  // Never run two captures at once. A second getUserMedia on an
  // already-captured tab yields a live-but-silent stream, which looks exactly
  // like a working pipeline that has stopped transcribing.
  if (cached.active && (await offscreenExists())) {
    if (cached.tabId === tabId) return; // already capturing this very tab
    stopCapture(); // switching tabs — tear the old one down first
  }

  await setCaptureState({ tabId }); // set first so relays reach the right tab
  // A warning from the previous capture must not survive into this one, or a
  // muted-tab notice outlives the tab it described.
  pipeline.captureWarning = undefined;
  pipeline.audioSilentMs = 0;
  try {
    // getMediaStreamId is callback-typed in @types/chrome — wrap as a promise.
    const streamId = await new Promise<string>((resolveId, rejectId) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        const err = chrome.runtime.lastError;
        if (err) rejectId(new Error(err.message));
        else resolveId(id);
      });
    });
    const settings = await getSettings();
    await ensureOffscreenDocument();
    void chrome.runtime.sendMessage({
      type: "OFFSCREEN_START",
      streamId,
      language: settings.language,
      wsEndpoint: resolveWsEndpoint(settings),
      audioPassthrough: settings.audioPassthrough,
    } satisfies ExtensionMessage);
    broadcastCaptureState(true);
    await setCaptureState({ pendingTabId: null });
    setActionBadge(""); // capture is live; the "click me" hint is done
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    broadcastCaptureState(false, message);
    await setCaptureState({ tabId: null });
  }
}

function stopCapture(): void {
  chrome.runtime
    .sendMessage({ type: "OFFSCREEN_STOP" } satisfies ExtensionMessage)
    .catch(() => {}); // no offscreen document — nothing to stop
  broadcastCaptureState(false); // relays hide to the content overlay
  void setCaptureState({ tabId: null, pendingTabId: null });
  setActionBadge("");
}

// ── Auto-start ───────────────────────────────────────────────────────────────

/**
 * Begin capture because the page started playing media.
 *
 * Chrome will not always allow this: `getMediaStreamId` needs the extension to
 * have access to the tab, which normally comes from a user gesture (activeTab).
 * When it refuses we do NOT fail silently — we badge the toolbar icon so one
 * click starts signing immediately, which is the fastest path Chrome permits.
 */
async function autoStartCapture(tabId: number): Promise<void> {
  await ready;
  // Cross-check the flag against reality. A stale "active" flag with no
  // offscreen document would block auto-start forever; a live capture must not
  // be duplicated.
  if (cached.active || cached.tabId !== null) {
    if (await offscreenExists()) return;
    await setCaptureState({ ...NO_CAPTURE });
  }

  const settings = await getSettings();
  // Never capture a tab on behalf of someone who has not finished setup —
  // they have not chosen a language yet, so we could not sign correctly.
  if (!settings.autoStart || !settings.onboarded) return;
  // `enabled` is the user's explicit intent, and it outranks auto-start.
  // Without this check, hitting Disconnect in Settings stopped capture and the
  // detector immediately re-armed over the still-playing video, restarting it
  // — so the avatar could never be turned off while something was playing.
  if (!settings.enabled) return;

  await setCaptureState({ pendingTabId: tabId });
  try {
    await startCapture(tabId);
    if (cached.active) await setCaptureState({ pendingTabId: null });
  } catch {
    // startCapture already reported the error; fall through to the badge.
  }

  if (!cached.active) {
    // Chrome refused without a gesture. Make the one required click obvious.
    setActionBadge("▶");
  }
}

function setActionBadge(text: string): void {
  void chrome.action.setBadgeText({ text });
  if (text) void chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
}

// ── Tab lifecycle ────────────────────────────────────────────────────────────
//
// Without these, closing or navigating away from the captured tab would leave
// the offscreen document holding a dead MediaStream and an open WebSocket:
// capture state would still read "active", and the next start would be
// rejected because the captured tab id was never cleared.

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (tabId === cached.tabId) stopCapture();
  if (tabId === cached.pendingTabId) await setCaptureState({ pendingTabId: null });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A real navigation tears down the page's media and content script, so the
  // capture that belonged to the old page is no longer meaningful.
  //
  // Keyed on `status` rather than `changeInfo.url` deliberately: url is only
  // populated for extensions holding the broad "tabs" permission, and reading
  // every tab's address would contradict what the popup promises about
  // privacy. `status` needs no extra permission and fires on the same event.
  //
  // This is a document load, not an SPA route change — YouTube's in-page
  // navigation keeps the same document and is handled by the media element
  // listeners in the content script instead.
  if (tabId === cached.tabId && changeInfo.status === "loading") stopCapture();
});

// ── Message router ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    switch (message.type) {
      case "GET_SETTINGS":
        getSettings().then((settings) =>
          sendResponse({ type: "SETTINGS", settings } satisfies ExtensionMessage),
        );
        return true;

      case "SAVE_SETTINGS":
        saveSettings(message.patch).then((settings) => {
          // If the language changed mid-capture, tell the offscreen doc so it
          // updates the live cloud session without a full restart.
          if (message.patch.language !== undefined && cached.active) {
            void chrome.runtime.sendMessage({
              type: "OFFSCREEN_SET_LANGUAGE",
              language: settings.language,
            } satisfies ExtensionMessage);
          }
          // Muting/unmuting takes effect on the live stream — the alternative
          // (restart capture) would drop audio and re-run a cold connect.
          if (message.patch.audioPassthrough !== undefined && cached.active) {
            void chrome.runtime.sendMessage({
              type: "OFFSCREEN_SET_PASSTHROUGH",
              audioPassthrough: settings.audioPassthrough,
            } satisfies ExtensionMessage);
          }
          // Push the new settings to the overlay so position/size/transcript
          // changes apply live.
          relayToContent({ type: "SETTINGS", settings });
          sendResponse({ type: "SETTINGS", settings } satisfies ExtensionMessage);
        });
        return true;

      case "GET_CAPTURE_STATE":
        sendResponse({
          type: "CAPTURE_STATE",
          active: cached.active,
        } satisfies ExtensionMessage);
        // Opening the popup means the user clicked the toolbar icon, which
        // grants activeTab — the gesture Chrome wanted before it would let us
        // capture. If a tab was queued for auto-start, this is the moment it
        // becomes possible, so the badged click starts signing on its own.
        //
        // Gated on the sender NOT being a tab, because that gesture is the
        // whole point. A content script asking the same question carries no
        // gesture, so acting on it would spend the queued capture on an attempt
        // Chrome must refuse — and clear `pendingTabId` in the process, so the
        // badged toolbar click that WOULD have worked then does nothing.
        // `sender.tab` is set for content scripts and undefined for the popup.
        if (!_sender.tab && cached.pendingTabId !== null && !cached.active) {
          const tabId = cached.pendingTabId;
          void setCaptureState({ pendingTabId: null }).then(() => startCapture(tabId));
        }
        return false;

      case "START_CAPTURE":
        void startCapture(message.tabId);
        return false;

      case "STOP_CAPTURE":
        stopCapture();
        return false;

      case "MEDIA_STARTED": {
        const tabId = _sender.tab?.id;
        if (tabId !== undefined) void autoStartCapture(tabId);
        return false;
      }

      case "SET_AUDIO_STREAMING":
        // Pre-recorded video with a caption track needs no ASR at all, so the
        // upload is suppressed while capture keeps running for passthrough.
        chrome.runtime
          .sendMessage({
            type: "OFFSCREEN_SET_STREAMING",
            enabled: message.enabled,
          } satisfies ExtensionMessage)
          .catch(() => {});
        return false;

      case "MAP_TEXT":
        // Caption cue from the page. Forwarded to the offscreen document,
        // which owns the socket. Costs no audio and no ASR.
        chrome.runtime
          .sendMessage({
            type: "OFFSCREEN_MAP_TEXT",
            text: message.text,
            at: message.at,
          } satisfies ExtensionMessage)
          .catch(() => {});
        return false;

      case "MEDIA_IDLE":
        // Deliberately does NOT stop capture. A pause is not a departure — the
        // avatar already holds its pose, and tearing down the socket would mean
        // a reconnect (and a cold ASR container) on every pause. Capture ends
        // when the user stops it or the tab goes away.
        return false;

      case "GET_DIAGNOSTICS": {
        // Ask the captured tab for the avatar half, then answer with both.
        // Kept on demand rather than pushed on a timer: nothing here is needed
        // unless someone has the diagnostics page open.
        const reply = (status: AvatarStatus | null) =>
          sendResponse({
            type: "DIAGNOSTICS",
            diagnostics: { ...pipeline, captureActive: cached.active, avatar: status },
          } satisfies ExtensionMessage);

        if (cached.tabId === null) {
          reply(null);
          return true;
        }
        chrome.tabs
          .sendMessage(cached.tabId, { type: "GET_AVATAR_STATUS" } satisfies ExtensionMessage)
          .then((res: ExtensionMessage | undefined) =>
            reply(res?.type === "AVATAR_STATUS" ? res.status : null),
          )
          // No content script on the tab (a chrome:// page, or it has not been
          // injected yet). That is itself the answer: there is no overlay.
          .catch(() => reply(null));
        return true;
      }

      case "AUDIO_CHUNK":
        pipeline.audioFrames += 1;
        if (message.stats.sent) pipeline.audioSent += 1;
        pipeline.lastRms = message.stats.rms;
        // Mirrors the offscreen watchdog so the Status page can show how long
        // the silence has run, not just that the last frame happened to be flat.
        pipeline.audioSilentMs =
          message.stats.rms > 0 ? 0 : pipeline.audioSilentMs + message.stats.durationMs;
        // Verification: confirm frames arrive at the right cadence/level and
        // whether each was streamed to the cloud.
        console.debug(
          `[SignStream] frame #${message.stats.seq} ` +
            `${message.stats.samples}smp @ ${message.stats.sampleRate}Hz ` +
            `(${message.stats.durationMs}ms, rms=${message.stats.rms.toFixed(4)}, ` +
            `sent=${message.stats.sent})`,
        );
        return false;

      case "CAPTURE_WARNING":
        // Capture stays active — this is "running but useless", not "stopped".
        pipeline.captureWarning = message.message ?? undefined;
        if (message.message) console.warn(`[SignStream] ${message.message}`);
        // Forward to the popup so an open Status page updates immediately
        // rather than waiting for its next poll.
        chrome.runtime.sendMessage(message).catch(() => {});
        return false;

      case "CLOUD_STATUS":
        pipeline.cloudConnected = message.connected;
        console.debug(`[SignStream] cloud ${message.connected ? "connected" : "disconnected"}`);
        return false;

      case "TRANSCRIPT":
        if (message.isFinal) {
          pipeline.transcripts += 1;
          pipeline.lastTranscript = message.text;
        }
        console.debug(
          `[SignStream] transcript${message.isFinal ? " (final)" : ""}: ${message.text}`,
        );
        relayToContent(message); // → overlay caption
        return false;

      case "SIGN_ID":
        pipeline.signIds += 1;
        pipeline.lastSignId = message.id;
        relayToContent(message); // → avatar gesture
        return false;

      default:
        return false;
    }
  },
);
