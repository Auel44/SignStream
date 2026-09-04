// Fetches sign keypoint clips by sign id and caches them.
//
// The backend pushes sign ids (e.g. `ghsl-hello-v1`); the actual animation data
// lives in the dictionary bucket behind CloudFront.
//
// Three layers stop a repeated word — or a replayed video — costing anything:
//
//   1. This in-memory map. A repeat within the session is a synchronous hit,
//      no network and no re-parse.
//   2. The browser's HTTP cache. Clips are served `immutable, max-age=1y`
//      (the version lives in the sign id, so a clip's bytes never change under
//      its URL), so even a cache miss here or a full page reload is usually
//      served from disk without touching the network.
//   3. CloudFront's edge cache, for anything that does reach the network.
//
// The in-memory layer is bounded. Clips are ~60–130 KB of JSON each, and
// materially larger once parsed into JS arrays; an unbounded map would grow
// without limit across a long session (a two-hour documentary can easily touch
// several hundred distinct words) and leak that memory into the host page.
// Eviction is cheap precisely because of layer 2 — a re-fetch after eviction
// normally costs a disk read, not a request.

import { resolveDictionaryBaseUrl, signClipUrl } from "../shared/config";
import type { ExtensionMessage, ExtensionSettings, SignClip } from "../shared/types";

/**
 * Cache budget, counted in animation frames rather than entries, because clip
 * length varies by an order of magnitude and frames are what actually consume
 * memory (67 joints × 3 coordinates each).
 *
 * ~8,000 frames is roughly 130 average clips — comfortably more than the
 * working vocabulary of any single video, while bounding worst-case growth.
 */
const MAX_CACHED_FRAMES = 8000;

/** Resolved clips, plus `null` for ids we know are unavailable (negative cache). */
const cache = new Map<string, SignClip | null>();
/** In-flight requests, so N rapid hits on the same id share one fetch. */
const inFlight = new Map<string, Promise<SignClip | null>>();
/** Running total of frames held in `cache`, kept in step with insert/evict. */
let cachedFrames = 0;

/**
 * Insert and evict least-recently-used entries until back inside budget.
 *
 * `Map` iterates in insertion order, so re-inserting on every hit (see
 * `touch`) makes the first key the least recently used one.
 */
function remember(signId: string, clip: SignClip | null): void {
  cache.set(signId, clip);
  cachedFrames += clip?.frames.length ?? 0;

  for (const [key, value] of cache) {
    if (cachedFrames <= MAX_CACHED_FRAMES) break;
    // Negative entries are a bare `null` — they cost nothing and are worth
    // keeping, since they save a doomed request for a gloss we have no clip
    // for. Only real clips are evicted.
    if (value === null || key === signId) continue;
    cache.delete(key);
    cachedFrames -= value.frames.length;
  }
}

/** Mark an entry as most recently used. */
function touch(signId: string, value: SignClip | null): void {
  cache.delete(signId);
  cache.set(signId, value);
}

function isSignClip(value: unknown): value is SignClip {
  if (typeof value !== "object" || value === null) return false;
  const clip = value as Partial<SignClip>;
  return (
    typeof clip.signId === "string" &&
    Array.isArray(clip.joints) &&
    Array.isArray(clip.frames)
  );
}

/**
 * Resolve a sign id to its clip. Returns `null` when no dictionary is
 * configured, the clip is missing (a gloss we have no recording for), or the
 * fetch fails — callers fall back to a placeholder gesture rather than
 * breaking playback.
 */
export function loadSignClip(
  signId: string,
  settings: Partial<ExtensionSettings>,
): Promise<SignClip | null> {
  const cached = cache.get(signId);
  if (cached !== undefined) {
    touch(signId, cached); // keep frequently-signed words resident
    return Promise.resolve(cached);
  }

  const existing = inFlight.get(signId);
  if (existing) return existing;

  const url = signClipUrl(resolveDictionaryBaseUrl(settings), signId);
  if (!url) {
    remember(signId, null);
    return Promise.resolve(null);
  }

  // Asked of the service worker rather than fetched here.
  //
  // A content script's `fetch` carries the PAGE's origin, so fetching a clip
  // from `http://localhost:8081` is a request from `https://www.youtube.com`
  // into the loopback address space — which Chrome refuses:
  //
  //   "blocked by CORS policy: Permission was denied for this request to
  //    access the `loopback` address space."
  //
  // Every clip failed that way, so the avatar received sign ids it could never
  // play. The service worker has the extension's own origin and its host
  // permissions, and is not bound by the page's rules.
  const request = chrome.runtime
    .sendMessage({ type: "FETCH_CLIP", url } satisfies ExtensionMessage)
    .then((res: ExtensionMessage | undefined) => {
      if (res?.type !== "CLIP_DATA") {
        // No answer at all — the worker was asleep or the context is gone.
        // Transient, so it must not be cached.
        console.warn(`[SignStream] no response from the service worker fetching ${signId}`);
        return null;
      }
      if (res.status >= 200 && res.status < 300) {
        const clip = isSignClip(res.body) ? res.body : null;
        if (!clip) console.debug(`[SignStream] malformed clip for ${signId}`);
        // A well-formed 200, or a 200 carrying junk: both are final answers.
        remember(signId, clip);
        return clip;
      }
      if (res.status === 404) {
        // Definitive: this language has no recording for that sign. Worth
        // remembering, so the same doomed request is not repeated all session.
        console.debug(`[SignStream] no clip for ${signId}`);
        remember(signId, null);
        return null;
      }
      // Status 0 is a network-level failure — server down, DNS, blocked. 5xx
      // says nothing about whether the clip exists either. Neither is cached,
      // so a dictionary that comes back later starts working again rather than
      // staying poisoned for the life of the page.
      console.warn(`[SignStream] clip fetch for ${signId} failed: status ${res.status}`);
      return null;
    })
    .catch((err) => {
      console.debug(`[SignStream] clip request for ${signId} errored:`, err);
      return null;
    })
    .finally(() => {
      inFlight.delete(signId);
    });

  inFlight.set(signId, request);
  return request;
}

/** Test/debug helper — drops every cached clip. */
export function clearSignClipCache(): void {
  cache.clear();
  inFlight.clear();
  cachedFrames = 0;
}
