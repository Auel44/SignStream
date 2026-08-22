"""SignStream text-to-gloss Lambda — EventBridge consumer.

Subscribes to `signstream.transcript` events published by the asr Lambda.
For each finalised transcript:

  1. Normalise the text (lowercase, drop punctuation, expand contractions).
  2. Greedy longest-match against the per-language dictionary.
  3. For each mapped sign, push the sign ID to the originating WebSocket
     client (so the avatar can play it) and fan out a `signstream.signId`
     event for downstream observers.

Handles the warm-up sentinel the same way the asr handler does.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from signstream_common import WARMUP_RESPONSE, is_warmup

from mapper import VALID_LANGUAGES, Dictionary, MappedSign, map_tokens
from normaliser import proper_noun_tokens, tokenise
from publisher import Publisher

log = logging.getLogger()
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# Module-level state re-used across warm invocations.
_publisher: Publisher | None = None
_dictionaries: dict[str, Dictionary] = {}


def _bootstrap() -> Publisher:
    global _publisher
    if _publisher is None:
        _publisher = Publisher(
            websocket_endpoint=os.environ["WEBSOCKET_ENDPOINT"],
            event_bus_name=os.environ.get("EVENT_BUS_NAME", "signstream-bus"),
            event_source=os.environ.get("EVENT_SOURCE", "signstream.text-to-gloss"),
        )
        log.info("text-to-gloss publisher ready")
    return _publisher


def _get_dictionary(language: str) -> Dictionary:
    key = language.upper()
    if key not in _dictionaries:
        _dictionaries[key] = Dictionary.load(language)
        log.info(
            "loaded %s dictionary with %d entries",
            key,
            _dictionaries[key].size(),
        )
    return _dictionaries[key]


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """EventBridge entry point.

    EventBridge delivers events one at a time (unlike SQS batches) with the
    detail payload nested under `detail`. When invoked directly by the
    health-warmer, the payload arrives at the top level with `warmup: true`.
    """
    if is_warmup(event):
        _bootstrap()
        return WARMUP_RESPONSE

    publisher = _bootstrap()

    detail = event.get("detail") or {}
    if not detail:
        log.warning("event has no detail payload; dropping")
        return {"emitted": 0, "reason": "no-detail"}

    try:
        connection_id: str = detail["connectionId"]
        language: str = detail["language"]
        text: str = detail["text"]
        is_final: bool = bool(detail.get("isFinal", False))
    except KeyError as exc:
        log.error("transcript event missing required field: %s", exc)
        return {"emitted": 0, "reason": f"missing:{exc}"}

    # Validate the language at the trust boundary. Even though upstream
    # Lambdas validate on write, this consumer must not trust the event
    # payload — an unexpected value must never reach the dictionary loader.
    if not isinstance(language, str) or language.upper() not in VALID_LANGUAGES:
        log.warning("dropping event with invalid language: %r", language)
        return {"emitted": 0, "reason": "invalid-language"}

    if not is_final:
        # Partial transcripts get displayed as captions but should not drive
        # avatar signs — the avatar would sign each word and then re-sign
        # the revised version a moment later.
        return {"emitted": 0, "reason": "partial"}

    if not text.strip():
        return {"emitted": 0, "reason": "empty-text"}

    dictionary = _get_dictionary(language)
    tokens = tokenise(text)
    # Proper nouns are read from the ORIGINAL text, before normalisation
    # lowercases it — capitalisation is the only signal that a word is a name
    # worth fingerspelling rather than ordinary vocabulary.
    signs: list[MappedSign] = map_tokens(
        tokens, dictionary, spellable=proper_noun_tokens(text)
    )

    log.debug(
        "conn=%s lang=%s tokens=%d matched=%d",
        connection_id,
        language,
        len(tokens),
        len(signs),
    )

    transcript_published_at = detail.get("publishedAt")

    for sign in signs:
        publisher.push_sign_id_to_client(
            connection_id=connection_id,
            sign_id=sign.sign_id,
        )
        publisher.publish_sign_id_event(
            connection_id=connection_id,
            language=language,
            sign_id=sign.sign_id,
            gloss=sign.gloss,
            source_text=" ".join(sign.source_tokens),
            transcript_published_at=transcript_published_at,
        )

    return {
        "emitted": len(signs),
        "connectionId": connection_id,
        "language": language,
    }
