# SignStream — Browser Extension (client)

Manifest V3 extension.

- **Step 1 (shell) — done:** popup UI + preferences + service worker.
- **Step 2 (capture) — done:** offscreen tab-audio capture → 16 kHz mono PCM, reported to
  the service worker.
- **Step 3 (cloud streaming) — client done:** contiguous 250 ms PCM frames are streamed
  over a WebSocket, with reconnect/backoff, and incoming transcripts are shown in the popup.
  The **backend** that terminates this socket is not built yet (skeleton only), so the popup
  will sit at "Connecting to cloud…" until an endpoint exists. Capture/playback still work.
- **Step 4 (avatar overlay) — done:** a content script mounts a Three.js avatar overlay on
  the page (position/size from settings), syncs it to the page `<video>` play/pause clock,
  shows the live transcript caption, and plays a placeholder gesture per incoming sign ID.
  Real keypoint pose clips (the sign dictionary) plug into the same joints in a later step.

## Configure the endpoint

Set `WS_ENDPOINT` in `src/shared/config.ts` once a backend exists
(e.g. `wss://<id>.execute-api.eu-west-1.amazonaws.com/prod`).

## Develop / build

```bash
npm install
npm run build      # type-checks, then builds to dist/
npm run dev        # rebuilds on change (watch)
```

## Load in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `extension/dist` folder.
5. Click the SignStream icon to open the popup.

The popup lets you toggle the avatar on/off, pick the sign language (ASL / BSL / GhSL),
and toggle the live transcript. Preferences persist via `chrome.storage.sync` and are
owned by the service worker (single source of truth).

## Verify capture (step 2)

1. Load the extension (above) and open a tab playing audio/video.
2. Open the popup and switch **Signing avatar** on — the status dot turns green
   ("Capturing tab audio"); tab audio keeps playing (passthrough).
3. Inspect the service worker: `chrome://extensions` → SignStream → **service worker**.
4. The console logs one `chunk #n … rms=…` line roughly every 200 ms while audio plays;
   `rms` rises with louder audio and sits near 0 in silence.

## Layout

| Path | Role |
|------|------|
| `manifest.json` | MV3 manifest (source paths; rewritten on build) |
| `src/background/service-worker.ts` | Settings source of truth + capture orchestration + message router |
| `src/popup/` | React + Tailwind preferences UI + capture status |
| `src/offscreen/` | Tab-audio capture, 16 kHz downsample, overlapping chunking |
| `src/shared/types.ts` | Shared settings, audio constants, message contracts |
| `src/content/` | Three.js avatar overlay, video-clock sync, transcript caption |
