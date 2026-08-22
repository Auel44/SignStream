// Reads a page's own caption track, so pre-recorded video needs no ASR.
//
// Why this is the preferred path
// ------------------------------
// For anything pre-recorded the transcript already exists, with timings. Using
// it instead of transcribing the audio is better on every axis that matters:
//
//   * Sync — cues carry start times, so a sign can be scheduled for the exact
//     moment its words are spoken, rather than arriving a second or two after.
//   * Accuracy — a published caption track beats moonshine/tiny comfortably.
//     (Observed: Moonshine rendered "AirPods Pro" as "The president's pro".)
//   * Cost — no audio streamed, no inference, no cloud round trip.
//
// Two sources, tried in order:
//
//   1. `video.textTracks`. The standard API, and the only one that gives
//      *lookahead*: setting a track to "hidden" populates every cue up front,
//      so the whole video can be mapped to signs before playback reaches it.
//   2. A DOM observer over the player's rendered caption element. Sites that
//      draw their own captions (YouTube among them) leave textTracks empty, so
//      this watches what is actually painted. It is perfectly in sync and
//      needs no private API, but it has no lookahead — a cue is only visible
//      once it is on screen.
//
// If neither yields anything the caller falls back to Moonshine. That fallback
// is a first-class path, not an error case: many videos have no captions, and
// the selectors below are the kind of thing a site can change at any time.

/** One caption cue: text plus the media time it belongs to. */
export interface CaptionCue {
  text: string;
  /** Media time in seconds when this text is spoken. */
  startTime: number;
}

export type CaptionSource = "texttrack" | "dom" | "none";

export interface CaptionFeed {
  source: CaptionSource;
  /** Whether cues are known ahead of playback (true only for texttrack). */
  lookahead: boolean;
  stop: () => void;
}

/** Rendered-caption containers for the players we know about. */
const CAPTION_SELECTORS = [
  ".ytp-caption-segment", // YouTube
  ".captions-text", // Vimeo
  ".vjs-text-track-cue", // video.js
  "[class*='caption-window'] [class*='caption']", // generic fallback
];

/**
 * Start feeding caption cues to `onCue`.
 *
 * Returns which source was used so the caller can decide whether to also run
 * audio capture. `source: "none"` means there are no captions and ASR is
 * required.
 */
export function startCaptions(
  video: HTMLMediaElement | null,
  onCue: (cue: CaptionCue) => void,
): CaptionFeed {
  const fromTracks = tryTextTracks(video, onCue);
  if (fromTracks) return fromTracks;

  const fromDom = tryDom(video, onCue);
  if (fromDom) return fromDom;

  return { source: "none", lookahead: false, stop: () => {} };
}

// ── Source 1: the standard TextTrack API ────────────────────────────────────

function tryTextTracks(
  video: HTMLMediaElement | null,
  onCue: (cue: CaptionCue) => void,
): CaptionFeed | null {
  const tracks = video?.textTracks;
  if (!tracks || tracks.length === 0) return null;

  let chosen: TextTrack | null = null;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (t.kind === "captions" || t.kind === "subtitles") {
      chosen = t;
      break;
    }
  }
  if (!chosen) return null;

  // "hidden" loads the cues without the browser drawing them — the page keeps
  // rendering its own captions, and we get the data.
  const previousMode = chosen.mode;
  chosen.mode = "hidden";

  const emitAll = () => {
    const cues = chosen?.cues;
    if (!cues || cues.length === 0) return false;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i] as VTTCue;
      const text = (cue.text ?? "").replace(/<[^>]*>/g, " ").trim();
      if (text) onCue({ text, startTime: cue.startTime });
    }
    return true;
  };

  // Cues may not be parsed yet on the first tick.
  if (!emitAll()) {
    const onLoad = () => {
      if (emitAll()) chosen?.removeEventListener("load", onLoad);
    };
    chosen.addEventListener("load", onLoad);
    // Some players populate cues without firing an event at all.
    const timer = window.setTimeout(() => emitAll(), 1500);
    return {
      source: "texttrack",
      lookahead: true,
      stop: () => {
        window.clearTimeout(timer);
        chosen?.removeEventListener("load", onLoad);
        if (chosen) chosen.mode = previousMode;
      },
    };
  }

  return {
    source: "texttrack",
    lookahead: true,
    stop: () => {
      if (chosen) chosen.mode = previousMode;
    },
  };
}

// ── Source 2: watch what the player paints ──────────────────────────────────

function tryDom(
  video: HTMLMediaElement | null,
  onCue: (cue: CaptionCue) => void,
): CaptionFeed | null {
  const present = CAPTION_SELECTORS.some((sel) => document.querySelector(sel));
  if (!present) return null;

  let lastText = "";
  const read = () => {
    const parts: string[] = [];
    for (const sel of CAPTION_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => {
        const t = (el.textContent ?? "").trim();
        if (t) parts.push(t);
      });
      if (parts.length) break; // first selector that matches owns the player
    }
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    // Rendered captions repaint constantly as words are added; only act when
    // the text actually changes, and only on the growing edge.
    if (!text || text === lastText) return;
    const addition = text.startsWith(lastText) ? text.slice(lastText.length).trim() : text;
    lastText = text;
    if (addition) onCue({ text: addition, startTime: video?.currentTime ?? 0 });
  };

  const observer = new MutationObserver(read);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  read();

  return {
    source: "dom",
    lookahead: false,
    stop: () => observer.disconnect(),
  };
}
