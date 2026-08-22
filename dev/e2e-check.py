"""End-to-end check against the local dev stack.

Verifies the same path the extension takes, without a browser:

  1. WebSocket connects with ?language= and gets the `ready` handshake.
  2. Binary 250 ms PCM frames are accepted at the rate the client sends them.
  3. Final transcripts come back and produce `signId` messages.
  4. Every emitted sign id resolves to a real clip over HTTP, with CORS headers
     and keypoint frames the avatar can actually play.

Run it with the stack up:

    python dev/e2e-check.py
    python dev/e2e-check.py --language GhSL --text "thank you doctor"
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import struct
import sys
import urllib.request

import websockets

FRAME_MS = 250
RATE = 16000
FRAME_SAMPLES = RATE * FRAME_MS // 1000


def tone_frame(index: int, amplitude: float = 0.25) -> bytes:
    """One 250 ms frame of 220 Hz tone — enough activity to trip the stub's
    speech heuristic. Real speech is what `moonshine` needs; this only proves
    frames are accepted and routed."""
    start = index * FRAME_SAMPLES
    return b"".join(
        struct.pack("<h", int(amplitude * 32767 * math.sin(2 * math.pi * 220 * (start + i) / RATE)))
        for i in range(FRAME_SAMPLES)
    )


def silence_frame() -> bytes:
    return b"\x00\x00" * FRAME_SAMPLES


def check_clip(base: str, sign_id: str) -> tuple[bool, str]:
    language = sign_id.split("-")[0]
    url = f"{base}/{language}/{sign_id}.json"
    try:
        with urllib.request.urlopen(url, timeout=10) as res:
            cors = res.headers.get("Access-Control-Allow-Origin")
            clip = json.loads(res.read())
    except Exception as exc:  # noqa: BLE001
        return False, f"{url} -> {exc}"
    if clip.get("signId") != sign_id:
        return False, f"{url} -> signId mismatch: {clip.get('signId')!r}"
    frames = clip.get("frames") or []
    joints = clip.get("joints") or []
    if not frames or len(joints) != 67:
        return False, f"{url} -> unusable clip ({len(joints)} joints, {len(frames)} frames)"
    if cors != "*":
        return False, f"{url} -> missing CORS header (got {cors!r})"
    return True, f"{len(frames)} frames, {clip['durationMs']}ms, gloss={clip['gloss']}"


async def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--ws", default="ws://localhost:8080")
    p.add_argument("--dictionary", default="http://localhost:8081")
    p.add_argument("--language", default="GhSL", choices=["ASL", "BSL", "GhSL"])
    p.add_argument("--text", default="thank you doctor water",
                   help="Text driven through the real gloss mapper.")
    p.add_argument("--frames", type=int, default=12)
    args = p.parse_args()

    failures: list[str] = []
    sign_ids: list[str] = []

    url = f"{args.ws}?language={args.language}"
    print(f"1. connecting  {url}")
    async with websockets.connect(url) as ws:
        first = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        if first.get("type") != "ready":
            failures.append(f"expected ready handshake, got {first}")
        print(f"   handshake: {first}")

        # ── audio path ──────────────────────────────────────────────────────
        print(f"2. streaming {args.frames} x {FRAME_MS}ms frames ({args.language})")
        for i in range(args.frames):
            await ws.send(tone_frame(i))
            await asyncio.sleep(0.01)
        for _ in range(6):  # silence, so the stub closes the sentence
            await ws.send(silence_frame())
            await asyncio.sleep(0.01)

        transcripts = 0
        try:
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=3))
                if msg["type"] == "transcript":
                    transcripts += 1
                    if msg["isFinal"]:
                        print(f"   final transcript: {msg['text']!r}")
                elif msg["type"] == "signId":
                    sign_ids.append(msg["id"])
        except asyncio.TimeoutError:
            pass
        print(f"   {transcripts} transcript message(s), {len(sign_ids)} sign id(s) from audio")

        # ── sign path, driven deterministically ─────────────────────────────
        print(f"3. gloss mapping for {args.text!r}")
        await ws.send(json.dumps({"action": "simulateTranscript", "text": args.text}))
        simulated: list[str] = []
        try:
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=3))
                if msg["type"] == "signId":
                    simulated.append(msg["id"])
        except asyncio.TimeoutError:
            pass
        print(f"   → {simulated}")
        if not simulated:
            failures.append("no sign ids produced from the gloss mapper")
        sign_ids.extend(simulated)

    # ── clip path ───────────────────────────────────────────────────────────
    print("4. fetching clips over HTTP")
    for sign_id in dict.fromkeys(sign_ids):
        ok, detail = check_clip(args.dictionary, sign_id)
        print(f"   {'OK  ' if ok else 'FAIL'} {sign_id:32} {detail}")
        if not ok:
            failures.append(detail)

    print()
    if failures:
        print(f"FAILED ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS — transcript, sign ids and playable keypoints all flowed end to end.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
