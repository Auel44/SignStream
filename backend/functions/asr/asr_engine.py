"""Pluggable streaming ASR engine.

The handler depends only on the `AsrEngine` protocol below, never on a
specific model implementation. Adding a new engine means: implement the
protocol, register it in `select_engine`, set `ASR_MODEL` in the Lambda env.

Engines must be stateless across calls in their own code — all per-session
state lives in the opaque `state` blob returned to the caller, which is
stored in `session_state.SessionCache` between frames.
"""

from __future__ import annotations

import logging
import os
import struct
from dataclasses import dataclass, field
from typing import Any, Iterable, Protocol

log = logging.getLogger(__name__)


# ── Result types ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TranscriptSegment:
    """One transcript snippet emitted by an engine for a single frame."""

    text: str
    is_final: bool


@dataclass
class StreamResult:
    """What an engine returns after consuming one frame."""

    state: Any
    segments: list[TranscriptSegment] = field(default_factory=list)


# ── Engine protocol ────────────────────────────────────────────────────────────


class AsrEngine(Protocol):
    """Streaming ASR contract. One method, frame in / segments out."""

    @property
    def name(self) -> str:
        """Identifier matching the `asrModel` enum in the transcript event schema."""
        ...

    def stream_frame(
        self,
        *,
        state: Any | None,
        pcm_int16_le: bytes,
        sample_rate: int,
    ) -> StreamResult:
        """Consume one frame and emit zero or more segments.

        `state` is whatever the engine returned on the previous call for the
        same connection (or `None` on the first frame / after a cache miss).
        """
        ...


# ── Stub engine ────────────────────────────────────────────────────────────────


# Canned transcripts so the stub feels like it's actually transcribing
# something during demos and tests. Cycles through this list as silence
# boundaries are detected.
_STUB_SENTENCES: tuple[str, ...] = (
    "hello and welcome to this video",
    "today we are going to look at sign language translation",
    "the avatar should appear on screen now",
    "this is a stub transcript for development",
    "switching to the next demo sentence",
)

# Audio activity heuristic. RMS of normalised samples above this threshold is
# treated as "speech", below as "silence".
_STUB_SPEECH_RMS_THRESHOLD = 0.01

# A finalisation is emitted after this many consecutive silence frames, on
# the assumption that the speaker has reached the end of a sentence.
_STUB_SILENCE_FRAMES_TO_FINAL = 2


@dataclass
class _StubState:
    """Carried across frames for the stub engine."""

    word_cursor: int = 0
    sentence_cursor: int = 0
    silence_streak: int = 0
    seen_speech_since_final: bool = False


class StubEngine:
    """Fully working fake engine — no ML, picks canned text driven by audio activity.

    Lets the rest of the pipeline (publisher, EventBridge, WebSocket push,
    text-to-gloss, dictionary lookup, avatar) be tested end-to-end without
    needing to ship a real model.
    """

    name = "stub"

    def stream_frame(
        self,
        *,
        state: Any | None,
        pcm_int16_le: bytes,
        sample_rate: int,
    ) -> StreamResult:
        st: _StubState = state if isinstance(state, _StubState) else _StubState()
        rms = _rms_int16(pcm_int16_le)
        segments: list[TranscriptSegment] = []

        if rms >= _STUB_SPEECH_RMS_THRESHOLD:
            # speech — extend the partial transcript by one word
            sentence = _STUB_SENTENCES[st.sentence_cursor % len(_STUB_SENTENCES)]
            words = sentence.split()
            st.word_cursor = min(st.word_cursor + 1, len(words))
            partial_text = " ".join(words[: st.word_cursor])
            st.seen_speech_since_final = True
            st.silence_streak = 0
            if partial_text:
                segments.append(TranscriptSegment(text=partial_text, is_final=False))
        else:
            # silence — count toward a sentence boundary if there was prior speech
            st.silence_streak += 1
            if (
                st.seen_speech_since_final
                and st.silence_streak >= _STUB_SILENCE_FRAMES_TO_FINAL
            ):
                sentence = _STUB_SENTENCES[st.sentence_cursor % len(_STUB_SENTENCES)]
                words = sentence.split()
                final_text = " ".join(words[: st.word_cursor]) or sentence
                segments.append(TranscriptSegment(text=final_text, is_final=True))
                st.sentence_cursor += 1
                st.word_cursor = 0
                st.seen_speech_since_final = False
                st.silence_streak = 0

        return StreamResult(state=st, segments=segments)


# ── Moonshine engine ────────────────────────────────────────────────────────


@dataclass
class _MoonshineState:
    """Buffer of recent samples plus the last partial transcript."""

    buffer_float: list[float] = field(default_factory=list)
    last_partial: str = ""
    #: Frames consumed since the last time we actually ran the model. Used to
    #: keep inference inside the realtime budget — see MoonshineEngine.
    frames_since_transcribe: int = 0
    #: Whether speech has been heard since the last final was emitted. Without
    #: it, a stretch of silence would re-finalise the same text repeatedly.
    heard_speech: bool = False


class MoonshineEngine:
    """Streaming ASR wrapper around Moonshine (Useful Sensors, MIT licence).

    Moonshine is purpose-built for fast, low-latency ASR on CPU/edge. Unlike
    Whisper it does *not* pad every input to 30 s — it processes only the
    audio it is given, so transcribing a short rolling buffer is cheap. That
    makes the buffer-and-retranscribe pattern below far lighter on a Lambda
    CPU than the equivalent Whisper wrapper.

    We use the ONNX build (`useful-moonshine-onnx`) rather than the Torch
    build: no PyTorch dependency, a much smaller container image, and good
    CPU throughput — ideal for AWS Lambda.

    Behaviour: accumulate audio, transcribe the rolling window on each frame
    to produce a partial, and emit a final segment (clearing the buffer) once
    a silence frame arrives after speech.

    Configuration
    -------------
    * `ASR_MOONSHINE_MODEL` — preset name: `moonshine/tiny` (fastest) or
      `moonshine/base` (more accurate). Defaults to `moonshine/base`.
    """

    name = "moonshine"

    def __init__(self) -> None:
        self._model_name = os.environ.get("ASR_MOONSHINE_MODEL", "moonshine/base")
        self._transcribe_fn = self._load_transcribe_fn()
        log.info("Moonshine engine ready: %s", self._model_name)

        # Rolling window of audio kept between frames, in seconds.
        self._max_window_seconds = 4.0
        self._silence_threshold_rms = 0.01

        # How many frames to consume between partial transcriptions.
        #
        # Transcribing the whole window on every frame cannot work: at a 250 ms
        # frame cadence that is four inferences per second of audio, and one
        # inference over a 4 s window costs ~500 ms even with a warm session.
        # The backlog then grows without bound and the transcript falls further
        # behind the video for as long as it plays.
        #
        # Running once per second instead costs ~0.5 s per second of audio,
        # which leaves headroom. Finals are unaffected — a silence boundary
        # always transcribes immediately, so the text that drives signing is
        # never delayed by this.
        self._transcribe_every_frames = int(
            os.environ.get("ASR_TRANSCRIBE_EVERY_FRAMES", "4")
        )

    def _load_transcribe_fn(self):
        """Return a callable (float32_array) -> str. Imported lazily so the
        stub engine and unit tests run without moonshine installed.

        The model is constructed ONCE here and reused for every call. This
        matters enormously: `moonshine_onnx.transcribe(audio, "moonshine/tiny")`
        rebuilds a `MoonshineOnnxModel` — two fresh ONNX Runtime inference
        sessions — whenever the `model` argument is a string. Passing the name
        per frame therefore paid full session construction 4x a second, which
        measured 3-6 seconds per call instead of ~500 ms, i.e. 12-30x slower
        than realtime. Passing the model *object* skips all of it.
        """
        try:
            from moonshine_onnx import (  # type: ignore[import-not-found]
                MoonshineOnnxModel,
                load_tokenizer,
                transcribe,
            )
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "useful-moonshine-onnx is not installed. Install it "
                "(`pip install useful-moonshine-onnx`) or use ASR_MODEL=stub."
            ) from exc

        model = MoonshineOnnxModel(model_name=self._model_name)
        tokenizer = load_tokenizer()

        def _run(arr) -> str:
            # `transcribe` accepts a preloaded model, and that is the whole
            # point — it then does no session construction.
            result = transcribe(arr, model)
            if isinstance(result, (list, tuple)):
                return " ".join(str(r).strip() for r in result).strip()
            return str(result).strip()

        # Keep a reference so the sessions are not garbage collected between
        # invocations of a warm container.
        self._model = model
        self._tokenizer = tokenizer
        return _run

    def stream_frame(
        self,
        *,
        state: Any | None,
        pcm_int16_le: bytes,
        sample_rate: int,
    ) -> StreamResult:
        st: _MoonshineState = (
            state if isinstance(state, _MoonshineState) else _MoonshineState()
        )
        segments: list[TranscriptSegment] = []

        samples = _int16_bytes_to_float(pcm_int16_le)
        st.buffer_float.extend(samples)

        max_samples = int(self._max_window_seconds * sample_rate)
        if len(st.buffer_float) > max_samples:
            del st.buffer_float[: len(st.buffer_float) - max_samples]

        rms = _rms_floats(samples)
        is_silence = rms < self._silence_threshold_rms
        st.frames_since_transcribe += 1
        if not is_silence:
            st.heard_speech = True

        # A silence boundary closes the utterance. Transcribe now regardless of
        # the throttle: this is the text that drives the avatar, so it must
        # reflect all the audio, not whatever the last partial happened to be.
        if is_silence and st.heard_speech:
            final = self._transcribe(st.buffer_float)
            if final:
                segments.append(TranscriptSegment(text=final, is_final=True))
            st.buffer_float.clear()
            st.last_partial = ""
            st.heard_speech = False
            st.frames_since_transcribe = 0
            return StreamResult(state=st, segments=segments)

        # Otherwise only run the model periodically — see
        # `_transcribe_every_frames` for why transcribing every frame cannot
        # keep up with the stream.
        if st.frames_since_transcribe >= self._transcribe_every_frames:
            st.frames_since_transcribe = 0
            partial = self._transcribe(st.buffer_float)
            if partial and partial != st.last_partial:
                segments.append(TranscriptSegment(text=partial, is_final=False))
                st.last_partial = partial

        return StreamResult(state=st, segments=segments)

    def _transcribe(self, samples: list[float]) -> str:
        if not samples:
            return ""
        import numpy as np  # type: ignore[import-not-found]

        arr = np.asarray(samples, dtype="float32")
        return self._transcribe_fn(arr)


# ── African-tuned Moonshine engine ────────────────────────────────────────────


class AfricanMoonshineEngine(MoonshineEngine):
    """Moonshine loaded from a checkpoint fine-tuned on AfriSpeech-200
    (Ghanaian / Nigerian / Kenyan / etc. accented English).

    Same rolling-window behaviour as the baseline engine; only the model
    weights differ. See `data/models/moonshine-african/README.md` for the
    training recipe.

    Configuration
    -------------
    * `ASR_MOONSHINE_MODEL_PATH` — local directory holding the fine-tuned
      ONNX model files (e.g. `/opt/model/moonshine-african`). Required.
    """

    name = "moonshine-african"

    def __init__(self) -> None:
        self._model_path = os.environ.get("ASR_MOONSHINE_MODEL_PATH")
        if not self._model_path:
            raise RuntimeError(
                "AfricanMoonshineEngine requires ASR_MOONSHINE_MODEL_PATH "
                "(local directory of the fine-tuned ONNX model files)."
            )
        self._model_name = self._model_path
        self._transcribe_fn = self._load_local_transcribe_fn()
        log.info("African Moonshine engine ready: %s", self._model_path)

        self._max_window_seconds = 4.0
        self._silence_threshold_rms = 0.01

    def _load_local_transcribe_fn(self):
        try:
            from moonshine_onnx import MoonshineOnnxModel  # type: ignore[import-not-found]
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "useful-moonshine-onnx is not installed. Install it "
                "(`pip install useful-moonshine-onnx`) or use ASR_MODEL=stub."
            ) from exc

        # Load the fine-tuned model from a local directory of ONNX files.
        model = MoonshineOnnxModel(models_dir=self._model_path)

        def _run(arr) -> str:
            tokens = model.generate(arr)
            # generate() returns token ids; moonshine ships a tokenizer helper.
            from moonshine_onnx import load_tokenizer  # type: ignore[import-not-found]

            tokenizer = load_tokenizer()
            text = tokenizer.decode_batch(tokens)
            if isinstance(text, (list, tuple)):
                return " ".join(str(t).strip() for t in text).strip()
            return str(text).strip()

        return _run


# ── Factory ───────────────────────────────────────────────────────────────────


def select_engine(name: str) -> AsrEngine:
    """Pick the engine for a given ASR_MODEL value."""
    if name == "stub":
        return StubEngine()
    if name == "moonshine":
        return MoonshineEngine()
    if name == "moonshine-african":
        return AfricanMoonshineEngine()
    if name in {"parakeet-tdt-streaming", "mms"}:
        raise NotImplementedError(
            f"engine '{name}' is on the roadmap but not yet implemented. "
            f"Use ASR_MODEL=stub, moonshine, or moonshine-african."
        )
    raise ValueError(f"unknown ASR_MODEL: {name!r}")


# ── Audio helpers ─────────────────────────────────────────────────────────────


def _int16_bytes_to_float(pcm: bytes) -> Iterable[float]:
    """Decode Int16 little-endian PCM bytes into normalised floats in [-1, 1]."""
    if len(pcm) % 2 != 0:
        raise ValueError(f"PCM byte length must be even, got {len(pcm)}")
    count = len(pcm) // 2
    ints = struct.unpack(f"<{count}h", pcm)
    return [s / 32768.0 for s in ints]


def _rms_int16(pcm: bytes) -> float:
    floats = list(_int16_bytes_to_float(pcm))
    return _rms_floats(floats)


def _rms_floats(samples: Iterable[float]) -> float:
    total = 0.0
    count = 0
    for s in samples:
        total += s * s
        count += 1
    if count == 0:
        return 0.0
    return (total / count) ** 0.5
