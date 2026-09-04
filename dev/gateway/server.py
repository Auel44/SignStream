"""Local dev gateway — the whole cloud pipeline in one WebSocket server.

What this replaces
------------------
In production the path is:

    extension → API Gateway ($connect / $default)
              → ws-audio-ingest Lambda → SQS
              → asr Lambda → EventBridge
              → text-to-gloss Lambda → API Gateway → extension

None of that is runnable on a laptop, and emulating API Gateway WebSockets,
SQS and EventBridge would test the emulator rather than the project. So this
server keeps the *same modules* and drops only the transport:

    asr_engine.select_engine()   ← the real engine, same as the asr Lambda
    normaliser.tokenise()        ← the real normaliser
    mapper.Dictionary/map_tokens ← the real dictionaries and greedy matcher

The message formats on the wire are the ones the extension already speaks, so
the client is completely unmodified. What is NOT exercised here: IAM, the SQS
retry/DLQ path, EventBridge fan-out, DynamoDB sequencing, and Lambda cold
starts. Everything that decides *what the avatar signs* is real.

Not for deployment — no auth, no rate limiting, single process.
"""

from __future__ import annotations

import array
import asyncio
import json
import logging
import math
import os
import sys
from pathlib import Path

import websockets
from websockets.asyncio.server import ServerConnection

# The Lambda source trees are mounted, not packaged — put them on the path so
# the real modules import exactly as they do in their own containers.
sys.path.insert(0, "/app/asr")
sys.path.insert(0, "/app/text-to-gloss")

from asr_engine import select_engine  # noqa: E402
from fingerspell import load_alphabet  # noqa: E402
from mapper import VALID_LANGUAGES, Dictionary, map_tokens  # noqa: E402
from normaliser import tokenise  # noqa: E402

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    # Time first would push the stage marker off the left edge, and the stage
    # markers are the point of this log — they line up with the CLIP lines the
    # dictionary container emits into the same stream.
    format="%(message)s",
)
log = logging.getLogger("gateway")

DEFAULT_LANGUAGE = "ASL"
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8080"))

# Log one AUDIO line per this many frames. Every frame would be 4 lines/second
# and drown the stages that matter; every 8th is one line every 2s — enough to
# see that audio is flowing and at what level.
AUDIO_LOG_EVERY = int(os.environ.get("AUDIO_LOG_EVERY", "8"))


def frame_rms(pcm_int16_le: bytes) -> float:
    """Loudness of one frame, 0–1. Shown so silence vs speech is visible."""
    samples = array.array("h")
    samples.frombytes(pcm_int16_le[: len(pcm_int16_le) // 2 * 2])
    if not samples:
        return 0.0
    return math.sqrt(sum(s * s for s in samples) / len(samples)) / 32768.0


def meter(rms: float, width: int = 20) -> str:
    """Tiny level meter so audio activity is readable at a glance."""
    filled = min(width, int(rms * width * 4))
    return "#" * filled + "." * (width - filled)

# Loaded once per process, like the Lambda's module-level globals.
ENGINE = select_engine(os.environ.get("ASR_MODEL", "stub"))
STUB = ENGINE.name == "stub"
DICTIONARIES: dict[str, Dictionary] = {}
ALPHABETS: dict[str, frozenset[str]] = {}


def alphabet_for(language: str) -> frozenset[str]:
    """Letters this language can actually fingerspell, read from the clips.

    Never assumed. A language missing even one letter cannot spell any word
    containing it — a guessed handshape is a wrong letter, not a near miss.
    """
    key = language.upper()
    if key not in ALPHABETS:
        clips = Path("/app/dictionary") / language.lower()
        ids = {f"{language.lower()}-{p.stem}" for p in clips.glob("*.json")}
        ALPHABETS[key] = load_alphabet(language, ids)
        n = len(ALPHABETS[key])
        if n == 26:
            log.info("%s alphabet: complete — fingerspelling enabled", key)
        else:
            missing = sorted(set("abcdefghijklmnopqrstuvwxyz") - ALPHABETS[key])
            log.info(
                "%s alphabet: %d/26 — fingerspelling limited (missing %s)",
                key, n, ", ".join(missing),
            )
    return ALPHABETS[key]


def dictionary_for(language: str) -> Dictionary:
    key = language.upper()
    if key not in DICTIONARIES:
        DICTIONARIES[key] = Dictionary.load(language)
        log.info("loaded %s dictionary: %d entries", key, DICTIONARIES[key].size())
    return DICTIONARIES[key]


def language_from_path(path: str) -> str:
    """Read `?language=` exactly as the ws-connect Lambda does, allowlist included."""
    _, _, query = path.partition("?")
    for part in query.split("&"):
        name, _, value = part.partition("=")
        if name == "language" and value.upper() in VALID_LANGUAGES:
            return value
    return DEFAULT_LANGUAGE


async def send_signs(
    ws: ServerConnection, text: str, language: str, at: float | None = None
) -> int:
    """Run the real text-to-gloss stage and push one signId per matched sign.

    `at` is echoed back untouched on every sign. It is the media time the words
    are spoken, supplied by the caption path; the client uses it to schedule the
    sign for that exact moment rather than playing it on arrival. The audio path
    omits it — those words have just been heard, so "now" is correct.
    """
    tokens = tokenise(text)
    # Proper nouns come from the raw text: capitalisation is the signal, and
    # normalisation destroys it.
    # `spellable=None` means "spell ANY word with no sign", not only the ones
    # that look like proper nouns. The narrower rule modelled a human
    # interpreter, who paraphrases an unfamiliar ordinary word rather than
    # spelling it — but paraphrasing needs a lexicon this system does not have,
    # so in practice the word was simply dropped and the sentence lost it.
    # Spelling it is the honest rendering of what was said.
    signs = map_tokens(
        tokens,
        dictionary_for(language),
        alphabet_for(language),
        spellable=None,
    )

    log.info("3 GLOSS  tokens %s%s", tokens, f"  @{at:.1f}s" if at is not None else "")
    for sign in signs:
        payload: dict = {"type": "signId", "id": sign.sign_id}
        if at is not None:
            payload["at"] = at
        # Tell the client this is one letter of a spelled word, not a lexical
        # sign. Letters are short and are read as a run rather than
        # individually, so the avatar plays them faster and without the pause
        # it puts between signs — which is how fingerspelling actually looks.
        if sign.is_fingerspell:
            payload["fingerspell"] = True
        await ws.send(json.dumps(payload))
        log.info(
            "3 GLOSS  %-24s → %-18s → %s%s",
            " ".join(sign.source_tokens),
            sign.gloss,
            sign.sign_id,
            "  (fingerspelled)" if sign.is_fingerspell else "",
        )

    # Words the dictionary has no sign for. Shown because "the avatar skipped
    # that word" is otherwise indistinguishable from a bug.
    matched = {t for s in signs for t in s.source_tokens}
    missing = [t for t in tokens if t not in matched]
    if missing:
        log.info("3 GLOSS  no sign for: %s", ", ".join(missing))
    log.info("3 GLOSS  %d sign(s) sent to the client", len(signs))
    return len(signs)


async def handle(ws: ServerConnection) -> None:
    language = language_from_path(ws.request.path if ws.request else "")
    state = None
    frames = 0
    log.info("client connected  language=%s  engine=%s", language, ENGINE.name)
    await ws.send(json.dumps({"type": "ready"}))

    try:
        async for message in ws:
            # Binary → audio frame. Text → control message. Same split as the
            # ws-audio-ingest Lambda makes on `isBase64Encoded`.
            if isinstance(message, bytes):
                frames += 1
                if frames % AUDIO_LOG_EVERY == 1:
                    rms = frame_rms(message)
                    log.info(
                        "1 AUDIO  frame #%-5d %5d bytes  %6.1f ms  [%s] rms=%.3f",
                        frames,
                        len(message),
                        len(message) / 2 / 16000 * 1000,
                        meter(rms),
                        rms,
                    )
                # Run inference off the event loop. `stream_frame` is a
                # blocking CPU call — in production each Lambda invocation owns
                # its own container so that is fine, but here one process
                # serves the socket, and blocking it stalls frame intake and
                # every outbound message until inference returns. Awaiting each
                # frame in turn still guarantees the engine sees them in order,
                # which a streaming model requires.
                result = await asyncio.to_thread(
                    ENGINE.stream_frame,
                    state=state,
                    pcm_int16_le=message,
                    sample_rate=16000,
                )
                state = result.state
                for segment in result.segments:
                    await ws.send(
                        json.dumps(
                            {
                                "type": "transcript",
                                "text": segment.text,
                                "isFinal": segment.is_final,
                            }
                        )
                    )
                    # Mark stub output on every line. Its canned sentences read
                    # exactly like a working transcript, so without this the
                    # only clue you are not transcribing the video is a single
                    # startup line scrolled far off the top.
                    tag = " [STUB — canned text, NOT the audio]" if STUB else ""
                    if segment.is_final:
                        log.info("2 ASR    FINAL   %r%s", segment.text, tag)
                        await send_signs(ws, segment.text, language)
                    else:
                        log.info("2 ASR    partial %r%s", segment.text, tag)
                continue

            try:
                control = json.loads(message)
            except json.JSONDecodeError:
                continue

            action = control.get("action")
            if action == "setLanguage":
                candidate = control.get("language")
                # Compare case-insensitively. mapper.VALID_LANGUAGES is
                # {"ASL","BSL","GHSL"} — all caps — while the client sends the
                # canonical "GhSL", so a direct membership test silently
                # rejected every GhSL setLanguage and left the session on ASL.
                if isinstance(candidate, str) and candidate.upper() in VALID_LANGUAGES:
                    language = candidate
                    log.info("language set to %s", language)
                else:
                    log.warning("ignoring setLanguage for %r", candidate)
            elif action == "mapText":
                # Caption path — text straight from the page's own track, with
                # the media time it belongs to. No audio, no ASR, no latency.
                text = str(control.get("text", "")).strip()
                at = control.get("at")
                if text:
                    log.info("2 CAPTION %r  @%.1fs", text, float(at or 0))
                    # Send the words back as a transcript as well as signing
                    # them.
                    #
                    # The overlay's caption line is fed by `transcript` frames,
                    # and this path used to emit none — it only produced sign
                    # ids. That went unnoticed while ASR ran alongside the
                    # caption feed and supplied the text as a side effect. The
                    # moment ASR was switched off for captioned video (it was
                    # duplicating every sign), the caption line went blank even
                    # though the words were right here.
                    #
                    # Marked final because a caption cue IS final — it is the
                    # publisher's own text, not a hypothesis being refined.
                    await ws.send(json.dumps({
                        "type": "transcript",
                        "text": text,
                        "isFinal": True,
                    }))
                    await send_signs(ws, text, language, float(at) if at is not None else None)
            elif action == "simulateTranscript":
                # DEV ONLY — no production counterpart. Lets the sign path be
                # driven from text so the avatar can be verified without a
                # microphone or a working ASR model.
                text = str(control.get("text", ""))
                log.info("simulated transcript: %r", text)
                await ws.send(
                    json.dumps({"type": "transcript", "text": text, "isFinal": True})
                )
                await send_signs(ws, text, language)
    except websockets.ConnectionClosed:
        pass
    finally:
        log.info("client disconnected after %d audio frame(s)", frames)


async def main() -> None:
    clips = Path("/app/dictionary")
    for lang in sorted(p.name for p in clips.iterdir() if p.is_dir()):
        log.info("clips available: %-5s %d", lang, len(list((clips / lang).glob("*.json"))))
    if STUB:
        log.warning("=" * 72)
        log.warning("  ASR_MODEL=stub — NOT transcribing. Output is canned text")
        log.warning("  that ignores the audio entirely. For real transcription:")
        log.warning("     docker compose -f dev/docker-compose.yml up -d gateway")
        log.warning("=" * 72)
    log.info("listening on ws://%s:%d  (ASR_MODEL=%s)", HOST, PORT, ENGINE.name)
    async with websockets.serve(handle, HOST, PORT, max_size=2**20):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
