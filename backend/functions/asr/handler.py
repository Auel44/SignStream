"""SignStream ASR Lambda — SQS consumer entry point.

Flow per SQS record:

  1. Parse the audio-frame JSON (schema: backend/events/audio-frame.json).
  2. Decode the base64 PCM payload.
  3. Look up the engine's per-session state in the LRU cache.
  4. Run one streaming inference step on the engine.
  5. For each transcript segment the engine emits, push it to the
     originating WebSocket client and (if the segment is final) also
     publish it onto EventBridge for the text-to-gloss consumer.
  6. Store the updated engine state back in the cache.

Per-record failures are surfaced via `batchItemFailures` so SQS only
re-drives the broken messages, not the whole batch.
"""

from __future__ import annotations

import json
import logging
import os
from base64 import b64decode
from typing import Any

from signstream_common import VALID_SIGN_LANGUAGES, is_warmup

from asr_engine import AsrEngine, select_engine
from publisher import Publisher
from session_state import SessionCache

# Uppercased allowlist for case-insensitive comparison. VALID_SIGN_LANGUAGES
# ships as {"ASL", "BSL", "GhSL"} (mixed case), so we normalise here.
_VALID_LANGUAGES_UPPER = frozenset(lang.upper() for lang in VALID_SIGN_LANGUAGES)

log = logging.getLogger()
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# Module-level globals so warm invocations re-use the loaded model and cache.
_engine: AsrEngine | None = None
_cache: SessionCache | None = None
_publisher: Publisher | None = None


def _bootstrap() -> tuple[AsrEngine, SessionCache, Publisher]:
    """Lazy initialisation. Runs once per Lambda container, not per invocation."""
    global _engine, _cache, _publisher
    if _engine is None:
        _engine = select_engine(os.environ.get("ASR_MODEL", "stub"))
        log.info("ASR engine ready: %s", _engine.name)
    if _cache is None:
        _cache = SessionCache(
            max_size=int(os.environ.get("SESSION_CACHE_SIZE", "128")),
            ttl_seconds=int(os.environ.get("SESSION_TTL_SECONDS", "600")),
        )
    if _publisher is None:
        _publisher = Publisher(
            websocket_endpoint=os.environ["WEBSOCKET_ENDPOINT"],
            event_bus_name=os.environ.get("EVENT_BUS_NAME", "signstream-bus"),
            event_source=os.environ.get("EVENT_SOURCE", "signstream.asr"),
        )
    return _engine, _cache, _publisher


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """Lambda entry point. SQS batch in, batchItemFailures out.

    Also responds to warm-up pings from the health-warmer Lambda: when the
    sentinel `{"warmup": true}` payload arrives, we ensure the engine is
    loaded (so the next real request lands on a hot model) and return
    immediately without scanning SQS records.
    """
    if is_warmup(event):
        _bootstrap()
        return {"warm": True, "engine": _engine.name if _engine else "unloaded"}

    engine, cache, publisher = _bootstrap()
    failures: list[dict[str, str]] = []

    for record in event.get("Records", []):
        message_id = record.get("messageId", "<unknown>")
        try:
            _process_record(record, engine=engine, cache=cache, publisher=publisher)
        except _PoisonRecord as exc:
            # A malformed message has no path to recovery; let it land in the DLQ
            # by NOT marking it as a failure — SQS will treat it as processed.
            log.error("poison record %s dropped: %s", message_id, exc)
        except Exception:
            log.exception("record %s failed; will retry via SQS", message_id)
            failures.append({"itemIdentifier": message_id})

    return {"batchItemFailures": failures}


# ── Per-record processing ─────────────────────────────────────────────────────


def _process_record(
    record: dict[str, Any],
    *,
    engine: AsrEngine,
    cache: SessionCache,
    publisher: Publisher,
) -> None:
    body = _parse_body(record.get("body"))
    try:
        connection_id: str = body["connectionId"]
        sequence: int = int(body["sequence"])
        language: str = body["language"]
        frame_b64: str = body["frame"]
    except (KeyError, TypeError, ValueError) as exc:
        raise _PoisonRecord(f"missing/invalid required field: {exc}") from exc

    # Defense in depth: the language ultimately drives a dictionary file
    # lookup in the downstream text-to-gloss Lambda. Reject anything not on
    # the allowlist here so a bad value never enters the event bus.
    if not isinstance(language, str) or language.upper() not in _VALID_LANGUAGES_UPPER:
        raise _PoisonRecord(f"invalid language: {language!r}")

    try:
        pcm_bytes = b64decode(frame_b64, validate=True)
    except Exception as exc:
        raise _PoisonRecord(f"frame base64 decode failed: {exc}") from exc

    prior_state = cache.get(connection_id)
    result = engine.stream_frame(
        state=prior_state,
        pcm_int16_le=pcm_bytes,
        sample_rate=16000,
    )
    cache.put(connection_id, result.state)

    log.debug(
        "asr conn=%s seq=%d emitted=%d", connection_id, sequence, len(result.segments)
    )

    for segment in result.segments:
        # Always push to the WebSocket so the caption is live.
        publisher.push_transcript_to_client(
            connection_id=connection_id,
            text=segment.text,
            is_final=segment.is_final,
        )
        # Only fan out finals to EventBridge — partials are too noisy for
        # text-to-gloss and would generate avatar gestures that get re-emitted
        # a moment later.
        if segment.is_final:
            publisher.publish_transcript_event(
                connection_id=connection_id,
                language=language,
                text=segment.text,
                is_final=True,
                last_frame_sequence=sequence,
                asr_model=engine.name,
            )


def _parse_body(raw: Any) -> dict[str, Any]:
    if raw is None:
        raise _PoisonRecord("record body is missing")
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8")
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise _PoisonRecord(f"body is not valid JSON: {exc}") from exc
    if isinstance(raw, dict):
        return raw
    raise _PoisonRecord(f"unexpected body type: {type(raw).__name__}")


class _PoisonRecord(Exception):
    """Marker for messages that cannot be processed by retrying. Dropped, not redriven."""
