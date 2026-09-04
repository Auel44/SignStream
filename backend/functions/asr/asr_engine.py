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
import time
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


# ── Decoder budget ───────────────────────────────────────────────────────────

_SAMPLE_RATE = 16_000

#: Tokens allowed per second of audio. Moonshine's own rule of thumb is about
#: six; eight leaves headroom for fast speech without leaving room for a
#: runaway. A 4 s partial therefore gets 32 tokens against the ~20 that normal
#: speech needs.
_TOKENS_PER_SECOND = 8

#: Floor, so a very short window can still produce a usable phrase.
_MIN_TOKENS = 12

#: Never exceed the model's own default, whatever the arithmetic says.
_ABSOLUTE_MAX_TOKENS = 192

#: How far behind realtime the engine may fall before it stops producing
#: partials.
#:
#: Partials are a nicety — they refine on screen and are never signed, because
#: only finals drive the gloss. Finals are not optional. So when inference has
#: cost more wall time than the audio it covered, the partials are what gets
#: dropped: the alternative is a backlog that grows for as long as the video
#: plays, which is precisely the "transcription lags further and further behind"
#: failure. Skipping them lets the engine spend its whole budget catching up.
_MAX_LAG_SECONDS = 1.0


# ── Degenerate-output guard ──────────────────────────────────────────────────


#: Times a phrase may repeat back-to-back before it is treated as a model
#: collapse rather than speech. Three is deliberate: "very very very" and
#: "no no no" are real, "ha ha ha ha ha" is plausible, but nothing said aloud
#: repeats the same words four times in one breath.
_MAX_PHRASE_REPEATS = 3

#: Longest phrase, in words, checked for repetition.
#:
#: Sized from a real failure rather than guessed. This was 6, which missed the
#: loop actually observed — "designed to dine in the 100 Hz," is SEVEN words, so
#: a 104-word runaway passed through untouched. 12 covers a clause-length cycle.
#:
#: Widening it is safe because the repeat threshold does the real work: a phrase
#: this long has to appear more than three times BACK TO BACK to be collapsed,
#: and nobody says the same twelve words four times in a row.
_MAX_REPEAT_PHRASE_WORDS = 12


def _collapse_repeats(text: str) -> str:
    """Fold a runaway repetition back down to a single occurrence.

    Encoder-decoder ASR models degenerate on audio they cannot resolve — music,
    overlapping speakers, a cough — and emit one phrase over and over until the
    token budget runs out. Observed live on this pipeline:

        'Wherewith chill, wherewith chill, wherewith chill, ...'   (x40)

    Left alone it is worse than a missing transcript. It reads to a hearing user
    as the model switching language mid-sentence, it costs the whole downstream
    budget, and every repeat is mapped to gloss and signed, so the avatar spells
    nonsense for a minute while real speech goes past unsigned.

    Collapsing rather than discarding is deliberate: the phrase is usually a
    mangled version of something that WAS said, so one copy is closer to the
    truth than nothing. Text with no runaway repetition is returned unchanged.
    """
    if not text:
        return text

    words = text.split()
    if len(words) < 2 * _MAX_PHRASE_REPEATS:
        return text

    for size in range(1, _MAX_REPEAT_PHRASE_WORDS + 1):
        out: list[str] = []
        i = 0
        collapsed = False
        while i < len(words):
            phrase = words[i : i + size]
            if len(phrase) < size:
                out.extend(words[i:])
                break
            # How many times does this phrase repeat immediately after itself?
            repeats = 1
            j = i + size
            while words[j : j + size] == phrase:
                repeats += 1
                j += size
            out.extend(phrase)
            if repeats > _MAX_PHRASE_REPEATS:
                collapsed = True
            i = j if repeats > 1 else i + size
            # A phrase repeated only a couple of times is kept in full.
            if 1 < repeats <= _MAX_PHRASE_REPEATS:
                for _ in range(repeats - 1):
                    out.extend(phrase)
        if collapsed:
            return " ".join(out)

    return text


# ── Moonshine engine ────────────────────────────────────────────────────────


@dataclass
class _MoonshineState:
    """Buffer of recent samples plus the last partial transcript."""

    buffer_float: list[float] = field(default_factory=list)
    #: The whole utterance since the last silence boundary.
    #:
    #: Kept separately from `buffer_float`, which is a short rolling window sized
    #: for cheap partials. The final used to be transcribed from that window, so
    #: an utterance longer than it lost its own opening: "Now, when you go to the
    #: fitness app on iPhone..." finalised as "For the fitness app on iPhone...".
    #: That is the text the avatar signs from, so the dropped words were dropped
    #: signs — the partials looked fine, which is what hid it.
    utterance_float: list[float] = field(default_factory=list)
    last_partial: str = ""
    #: Frames consumed since the last time we actually ran the model. Used to
    #: keep inference inside the realtime budget — see MoonshineEngine.
    frames_since_transcribe: int = 0
    #: Whether speech has been heard since the last final was emitted. Without
    #: it, a stretch of silence would re-finalise the same text repeatedly.
    heard_speech: bool = False
    #: Wall-clock seconds spent transcribing that the arriving audio has not yet
    #: paid for. Above zero means inference is running behind the stream; the
    #: arrival of each frame pays it down by that frame's duration.
    lag_s: float = 0.0


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
        #: Ceiling on one unbroken utterance, for the final transcription.
        #: Long enough for a normal spoken sentence, short enough that the
        #: inference at a silence boundary stays well inside realtime.
        self._max_utterance_seconds = float(
            os.environ.get("ASR_MAX_UTTERANCE_SECONDS", "15")
        )
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
            )
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "useful-moonshine-onnx is not installed. Install it "
                "(`pip install useful-moonshine-onnx`) or use ASR_MODEL=stub."
            ) from exc

        model = MoonshineOnnxModel(model_name=self._model_name)
        tokenizer = load_tokenizer()

        def _run(arr) -> str:
            # NOT `transcribe(arr, model)`. That helper calls
            # `model.generate(audio)` with no `max_len`, which falls back to a
            # flat 192 tokens no matter how much audio was passed.
            #
            # Decoding is autoregressive, so the token ceiling IS the worst-case
            # cost: ~20 tokens for a healthy 4 s window, 192 when the model
            # degenerates into repeating a phrase. That is ~10x the work for one
            # frame, and it is not a one-off hiccup — the frames that arrive
            # during it queue behind it, so the transcript falls seconds behind
            # the audio and never catches up. Observed live, and the giveaway is
            # that the runaway text stops mid-word: it hit the 192 ceiling.
            #
            # Sizing the ceiling to the audio bounds the damage to ~1.6x normal
            # and truncates a runaway early instead of letting it run to the cap.
            seconds = len(arr) / _SAMPLE_RATE
            max_len = int(
                min(
                    _ABSOLUTE_MAX_TOKENS,
                    max(_MIN_TOKENS, seconds * _TOKENS_PER_SECOND),
                )
            )
            audio = arr if getattr(arr, "ndim", 1) == 2 else arr[None, ...]
            tokens = model.generate(audio, max_len=max_len)
            decoded = tokenizer.decode_batch(tokens)
            if isinstance(decoded, (list, tuple)):
                return " ".join(str(r).strip() for r in decoded).strip()
            return str(decoded).strip()

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
        st.utterance_float.extend(samples)

        max_samples = int(self._max_window_seconds * sample_rate)
        if len(st.buffer_float) > max_samples:
            del st.buffer_float[: len(st.buffer_float) - max_samples]

        # The utterance buffer is bounded too, or a speaker who never pauses
        # would grow it without limit and each final would cost proportionally
        # more inference — the transcript falling further behind the video the
        # longer it ran. Dropping the oldest audio past the cap loses the start
        # of a very long sentence, which is strictly better than losing the end
        # of every sentence after it.
        max_utterance = int(self._max_utterance_seconds * sample_rate)
        if len(st.utterance_float) > max_utterance:
            del st.utterance_float[: len(st.utterance_float) - max_utterance]

        # Each arriving frame is another `frame_seconds` of realtime, which is
        # the budget inference has to fit inside.
        st.lag_s = max(0.0, st.lag_s - len(samples) / sample_rate)

        rms = _rms_floats(samples)
        is_silence = rms < self._silence_threshold_rms
        st.frames_since_transcribe += 1
        if not is_silence:
            st.heard_speech = True

        # A silence boundary closes the utterance. Transcribe now regardless of
        # the throttle: this is the text that drives the avatar, so it must
        # reflect all the audio, not whatever the last partial happened to be.
        if is_silence and st.heard_speech:
            started = time.perf_counter()
            final = _collapse_repeats(self._transcribe(st.utterance_float))
            st.lag_s += time.perf_counter() - started
            if final:
                segments.append(TranscriptSegment(text=final, is_final=True))
            st.buffer_float.clear()
            st.utterance_float.clear()
            st.last_partial = ""
            st.heard_speech = False
            st.frames_since_transcribe = 0
            return StreamResult(state=st, segments=segments)

        # Otherwise only run the model periodically — see
        # `_transcribe_every_frames` for why transcribing every frame cannot
        # keep up with the stream.
        if st.frames_since_transcribe >= self._transcribe_every_frames:
            st.frames_since_transcribe = 0

            # Behind realtime: skip this partial rather than add to the backlog.
            # Only finals are signed, so nothing the avatar needs is lost, and
            # skipping is what lets the engine catch up instead of drifting
            # further behind for the rest of the video.
            if st.lag_s > _MAX_LAG_SECONDS:
                log.debug("skipping partial: %.2fs behind realtime", st.lag_s)
                return StreamResult(state=st, segments=segments)

            started = time.perf_counter()
            partial = _collapse_repeats(self._transcribe(st.buffer_float))
            st.lag_s += time.perf_counter() - started
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
        #: Ceiling on one unbroken utterance, for the final transcription.
        #: Long enough for a normal spoken sentence, short enough that the
        #: inference at a silence boundary stays well inside realtime.
        self._max_utterance_seconds = float(
            os.environ.get("ASR_MAX_UTTERANCE_SECONDS", "15")
        )
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
