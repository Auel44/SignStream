"""Tests for the ASR engine abstraction and the stub implementation."""

from __future__ import annotations

import pytest

from asr_engine import StubEngine, select_engine
from tests.conftest import silence_frame, speech_frame


def test_stub_engine_emits_partial_on_speech_frame() -> None:
    engine = StubEngine()
    result = engine.stream_frame(
        state=None,
        pcm_int16_le=speech_frame(),
        sample_rate=16000,
    )
    assert any(not seg.is_final and seg.text for seg in result.segments)


def test_stub_engine_emits_final_after_silence_following_speech() -> None:
    engine = StubEngine()
    state = None

    # Speak a few frames so a partial is in flight.
    for _ in range(3):
        result = engine.stream_frame(
            state=state, pcm_int16_le=speech_frame(), sample_rate=16000
        )
        state = result.state

    # Then enough silence frames to trigger the final.
    final_seen = False
    for _ in range(3):
        result = engine.stream_frame(
            state=state, pcm_int16_le=silence_frame(), sample_rate=16000
        )
        state = result.state
        if any(seg.is_final for seg in result.segments):
            final_seen = True
            break
    assert final_seen


def test_stub_engine_pure_silence_emits_nothing() -> None:
    engine = StubEngine()
    state = None
    for _ in range(5):
        result = engine.stream_frame(
            state=state, pcm_int16_le=silence_frame(), sample_rate=16000
        )
        state = result.state
        assert result.segments == []


def test_select_engine_stub() -> None:
    engine = select_engine("stub")
    assert engine.name == "stub"


def test_select_engine_unknown() -> None:
    with pytest.raises(ValueError):
        select_engine("not-a-real-engine")


def test_select_engine_unimplemented_models() -> None:
    for name in ("parakeet-tdt-streaming", "mms"):
        with pytest.raises(NotImplementedError):
            select_engine(name)


def test_select_engine_moonshine_african_requires_model_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The African-tuned Moonshine engine cannot boot without a model path."""
    monkeypatch.delenv("ASR_MOONSHINE_MODEL_PATH", raising=False)
    with pytest.raises(RuntimeError, match="ASR_MOONSHINE_MODEL_PATH"):
        select_engine("moonshine-african")


def test_select_engine_moonshine_requires_package(monkeypatch: pytest.MonkeyPatch) -> None:
    """Selecting the real Moonshine engine without the package installed
    raises a clear RuntimeError (rather than a bare ImportError)."""
    import sys

    # Ensure the import fails even if the package is somehow present.
    monkeypatch.setitem(sys.modules, "moonshine_onnx", None)
    with pytest.raises(RuntimeError, match="useful-moonshine-onnx"):
        select_engine("moonshine")
