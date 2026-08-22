// Runtime configuration for the extension.
//
// Endpoints resolve in this order:
//   1. the value saved in extension settings (editable in the popup), then
//   2. a build-time default baked in from a Vite env var, then
//   3. a localhost fallback for local development.
//
// Keeping them in settings means one build can be pointed at a local backend
// or a deployed stack without recompiling — useful because the deployed
// WebSocket URL is only known after `terraform apply`.

import type { ExtensionSettings, SignLanguage } from "./types";

/**
 * Build-time defaults. Set these in `.env` (or the shell) before `npm run
 * build` to bake a deployed stack into the artefact:
 *
 *   VITE_WS_ENDPOINT=wss://abc123.execute-api.eu-west-1.amazonaws.com/prod
 *   VITE_DICTIONARY_BASE_URL=https://d1234.cloudfront.net
 */
const BUILD_WS_ENDPOINT = import.meta.env?.VITE_WS_ENDPOINT ?? "";
const BUILD_DICTIONARY_BASE_URL = import.meta.env?.VITE_DICTIONARY_BASE_URL ?? "";

/** Used when neither settings nor the build define an endpoint. */
const DEV_WS_ENDPOINT = "ws://localhost:8080";

/**
 * Where the extension streams captured audio.
 *
 * The backend terminates this at API Gateway (`$connect`, `$default`,
 * `$disconnect`). Until one is reachable the popup shows "Connecting to
 * cloud…" and frames are dropped — capture and passthrough keep working.
 */
export function resolveWsEndpoint(settings?: Partial<ExtensionSettings>): string {
  return settings?.wsEndpoint?.trim() || BUILD_WS_ENDPOINT || DEV_WS_ENDPOINT;
}

/**
 * The WebSocket URL to dial, carrying the user's chosen sign language.
 *
 * The backend's `$connect` handler reads `?language=` and stores it on the
 * connection row, so the very first audio frame is already tagged correctly.
 * Without it `$connect` falls back to its ASL default and every frame sent
 * before the follow-up `setLanguage` control message lands is transcribed
 * against the wrong dictionary — a visible wrong-language flash at the start
 * of every session for GhSL users.
 *
 * Casing is preserved deliberately: the backend allowlist is a case-sensitive
 * exact match on {"ASL", "GhSL"}, so lowercasing here would silently
 * fall back to the default.
 */
export function wsUrlForLanguage(
  endpoint: string,
  language: SignLanguage,
): string {
  if (!endpoint) return endpoint;
  try {
    // Parsing handles an endpoint that already carries a query string or a
    // stage path, rather than blindly appending "?language=".
    const url = new URL(endpoint);
    url.searchParams.set("language", language);
    return url.toString();
  } catch {
    // Not a parseable absolute URL (e.g. a half-typed value in settings).
    // Fall back to manual joining so capture still gets a chance to connect.
    const separator = endpoint.includes("?") ? "&" : "?";
    return `${endpoint}${separator}language=${encodeURIComponent(language)}`;
  }
}

/**
 * Base URL sign clips are fetched from, e.g. a CloudFront distribution in
 * front of the dictionary bucket. Clips live at
 * `<base>/<language>/<sign-id>.json`.
 *
 * Empty means "no remote dictionary configured" — the avatar then falls back
 * to a neutral placeholder gesture rather than failing.
 */
export function resolveDictionaryBaseUrl(
  settings?: Partial<ExtensionSettings>,
): string {
  const raw = settings?.dictionaryBaseUrl?.trim() || BUILD_DICTIONARY_BASE_URL;
  return raw.replace(/\/+$/, ""); // no trailing slash — we join with '/'
}

/**
 * Clip URL for a sign id. Sign ids are `<language>-<gloss-slug>-<version>`
 * (e.g. `ghsl-hello-v1`), and clips are stored per language, so the language
 * prefix becomes the folder.
 */
export function signClipUrl(baseUrl: string, signId: string): string | null {
  if (!baseUrl) return null;
  const language = signId.split("-")[0];
  if (!language) return null;
  return `${baseUrl}/${language}/${signId}.json`;
}
