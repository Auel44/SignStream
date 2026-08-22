// Tracks the page's media element so the avatar can follow it exactly.
//
// The interpreter is only correct if it moves with the stream. Everything the
// user can do to playback has a matching consequence for signing:
//
//   play / pause      → run / hold the avatar
//   seek (any jump)   → DISCARD queued signs; they describe audio that is now
//                       in the past or was never heard. Signing them would show
//                       the wrong words for the new position.
//   playbackRate      → sign at the same multiple, or the avatar falls behind
//   ended             → hold and clear
//   buffering/stall   → hold; the audio the cloud is transcribing has stopped
//   source change     → clear (SPA navigation, autoplay-next, a new video)
//
// Listeners are attached in the CAPTURE phase on `document` rather than on one
// element. Media events do not bubble, but they do capture — so this sees every
// <video> and <audio> on the page, including ones swapped in later. That matters
// because YouTube replaces its player element on navigation, and an element-bound
// listener would go silent after the first video.

/** Everything the avatar needs to stay in step with the page. */
export interface MediaState {
  /** Media is actively producing audio right now. */
  playing: boolean;
  /** The element's rate — 1 is normal. Multiplies the signing speed. */
  playbackRate: number;
}

export interface MediaSyncCallbacks {
  onState: (state: MediaState) => void;
  /** Queued signs are stale and must be dropped (seek, source change, end). */
  onFlush: () => void;
  /** Any media began playing — used to trigger auto-start. */
  onMediaStarted?: () => void;
  /** Nothing on the page is playing any more. */
  onMediaIdle?: () => void;
}

const MEDIA_EVENTS = [
  "play",
  "playing",
  "pause",
  "ended",
  "seeking",
  "seeked",
  "ratechange",
  "waiting",
  "stalled",
  "emptied",
  "loadstart",
  "volumechange",
] as const;

export class VideoSync {
  private cbs: MediaSyncCallbacks | null = null;
  /** The element we are currently following. */
  private active: HTMLMediaElement | null = null;
  private attached = false;
  /** Last reported playing state, so callbacks fire on transitions only. */
  private lastPlaying = false;

  attach(cbs: MediaSyncCallbacks): void {
    this.cbs = cbs;
    if (!this.attached) {
      for (const type of MEDIA_EVENTS) {
        document.addEventListener(type, this.onMediaEvent, true);
      }
      this.attached = true;
    }
    // Adopt whatever is already on the page — capture may start mid-video.
    this.active = findPlayingMedia() ?? findLargestVideo();
    this.emit();
  }

  detach(): void {
    if (this.attached) {
      for (const type of MEDIA_EVENTS) {
        document.removeEventListener(type, this.onMediaEvent, true);
      }
      this.attached = false;
    }
    this.active = null;
    this.cbs = null;
  }

  /** Current media time in seconds. */
  get currentTime(): number {
    return this.active?.currentTime ?? 0;
  }

  /** The element being followed, so the caption reader can attach to it. */
  get mediaElement(): HTMLMediaElement | null {
    return this.active;
  }

  /**
   * Whether this is a live stream rather than a recording.
   *
   * A live stream has no end, so `duration` is `Infinity` — the HTML spec's
   * own marker for an unbounded media resource, and consistent across players.
   *
   * `NaN` (metadata not loaded yet) is deliberately treated as *not* live:
   * guessing live would skip the caption path on a recording that is merely
   * still loading, and the check is re-run as playback state changes.
   *
   * The distinction decides the whole strategy. A recording has a transcript
   * that can be read ahead and signed in sync; a live stream has not been
   * spoken yet and can only be transcribed as it arrives.
   */
  get isLive(): boolean {
    return this.active?.duration === Infinity;
  }

  private onMediaEvent = (event: Event): void => {
    const el = event.target;
    if (!isMediaElement(el)) return;

    // Follow whichever element is actually playing. A page can hold several
    // (ads, previews, muted background loops); the one that just started is
    // the one the user is listening to.
    if (event.type === "play" || event.type === "playing") {
      this.active = el;
    } else if (el !== this.active) {
      // An event from a background element tells us nothing about the stream
      // the user is watching.
      return;
    }

    switch (event.type) {
      // Every one of these means the audio behind any queued sign is no longer
      // the audio that is about to play:
      //   seeking   — scrubbed, skipped ahead, or jumped back
      //   ended     — including a loop's jump back to the start
      //   emptied   — the element's source was torn down
      //   loadstart — a new source is loading (autoplay-next, SPA navigation)
      case "seeking":
      case "ended":
      case "emptied":
      case "loadstart":
        this.cbs?.onFlush();
        break;
    }

    this.emit();
  };

  /**
   * `paused` alone is not enough: during a seek or a buffer stall the element
   * reports `paused === false` while producing no audio at all. Signing on
   * through a stall would drift permanently out of step.
   */
  private isPlaying(): boolean {
    const el = this.active;
    if (!el) return false;
    return !el.paused && !el.ended && !el.seeking && el.readyState >= 3;
  }

  private emit(): void {
    const playing = this.isPlaying();

    this.cbs?.onState({
      playing,
      playbackRate: this.active?.playbackRate || 1,
    });

    // Fire the started/idle callbacks only on a real transition. Raw events are
    // far too noisy for this: `playing` fires again after every buffer stall,
    // so a struggling connection would otherwise spam the service worker with
    // auto-start requests for a tab that is already capturing.
    if (playing !== this.lastPlaying) {
      this.lastPlaying = playing;
      if (playing) this.cbs?.onMediaStarted?.();
      else if (!anyMediaPlaying()) this.cbs?.onMediaIdle?.();
    }
  }
}

// ── Element discovery ────────────────────────────────────────────────────────

function isMediaElement(value: EventTarget | null): value is HTMLMediaElement {
  return value instanceof HTMLMediaElement;
}

function allMedia(): HTMLMediaElement[] {
  return Array.from(document.querySelectorAll("video, audio"));
}

export function anyMediaPlaying(): boolean {
  return allMedia().some((m) => !m.paused && !m.ended);
}

function findPlayingMedia(): HTMLMediaElement | null {
  return allMedia().find((m) => !m.paused && !m.ended) ?? null;
}

function findLargestVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video"));
  if (videos.length === 0) return null;
  return videos.reduce((best, v) =>
    v.clientWidth * v.clientHeight > best.clientWidth * best.clientHeight ? v : best,
  );
}
