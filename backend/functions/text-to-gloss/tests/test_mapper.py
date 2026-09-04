"""Tests for the greedy phrase → gloss → sign-ID mapper."""

from __future__ import annotations

import pytest

from fingerspell import MAX_SPELLED_PER_UTTERANCE
from mapper import Dictionary, map_tokens, to_sign_id


def test_to_sign_id_basic() -> None:
    assert to_sign_id("ASL", "HELLO") == "asl-hello-v1"


def test_to_sign_id_multiword_gloss() -> None:
    assert to_sign_id("ASL", "THANK-YOU") == "asl-thank-you-v1"
    assert to_sign_id("BSL", "SIGN-LANGUAGE") == "bsl-sign-language-v1"


def test_dictionary_lookup_case_insensitive() -> None:
    d = Dictionary("ASL", {"Hello": "HELLO"})
    assert d.lookup("hello") == "HELLO"
    assert d.lookup("HELLO") is None  # keys are normalised to lowercase


def test_map_tokens_greedy_prefers_longest_phrase() -> None:
    d = Dictionary("ASL", {"thank you": "THANK-YOU", "thank": "THANK", "you": "YOU"})
    signs = map_tokens(["thank", "you"], d)
    assert len(signs) == 1
    assert signs[0].gloss == "THANK-YOU"
    assert signs[0].sign_id == "asl-thank-you-v1"
    assert signs[0].source_tokens == ("thank", "you")


def test_map_tokens_falls_back_to_single_words() -> None:
    d = Dictionary("ASL", {"thank you": "THANK-YOU", "thank": "THANK", "sam": "SAM"})
    signs = map_tokens(["thank", "sam"], d)
    assert [s.gloss for s in signs] == ["THANK", "SAM"]


def test_map_tokens_skips_unknown_words_silently() -> None:
    d = Dictionary("ASL", {"hello": "HELLO", "world": "WORLD"})
    signs = map_tokens(["hello", "beautiful", "world"], d)
    assert [s.gloss for s in signs] == ["HELLO", "WORLD"]


def test_map_tokens_empty_input() -> None:
    d = Dictionary("ASL", {"hello": "HELLO"})
    assert map_tokens([], d) == []


def test_dictionary_load_bundled_asl() -> None:
    """Generated from the WLASL clip set, whose glosses are space-separated."""
    d = Dictionary.load("ASL")
    assert d.size() > 1000
    assert d.lookup("hello") == "HELLO"
    assert d.lookup("thank you") == "THANK YOU"


def test_dictionary_load_bundled_asl_keys_are_normalised() -> None:
    """Keys must be in the form the normaliser emits, not the raw gloss.

    WLASL glosses this "don't want", but the normaliser expands "n't" to
    " not" before lookup — so a verbatim key could never be hit.
    """
    d = Dictionary.load("ASL")
    assert d.lookup("do not want") == "DON'T WANT"
    assert d.lookup("don't want") is None


def test_bsl_is_locked_out() -> None:
    """BSL must be refused, not served from its placeholder dictionary.

    No public BSL keypoint dataset exists to convert, so the language would
    resolve to a single clip and the avatar would stand still through every
    sentence. Rejecting it at the boundary is the honest behaviour.
    """
    with pytest.raises(ValueError):
        Dictionary.load("BSL")


def test_dictionary_load_bundled_ghsl() -> None:
    """The GhSL vocabulary is generated from the real clip set, not hand-written.

    It is deliberately *not* asserted to contain "hello": the GSL OpenPose
    lexicon we converted has no HELLO recording, and adding an entry for a
    gloss with no clip is exactly the drift build_gloss_vocabulary.py exists
    to prevent. Assert against glosses that do have clips instead.
    """
    d = Dictionary.load("GhSL")
    assert d.size() > 1000
    assert d.lookup("thank you") == "THANK_YOU"
    assert d.lookup("water") == "WATER"
    assert d.lookup("hello") is None


def test_dictionary_rejects_empty_language() -> None:
    with pytest.raises(ValueError):
        Dictionary("", {"hello": "HELLO"})


@pytest.mark.parametrize(
    "malicious",
    [
        "../../../../etc/passwd",
        "../../etc/hosts",
        "..\\..\\windows\\system32\\config",
        "asl/../../../secret",
        "/etc/shadow",
        "asl\x00../../etc/passwd",
        "FRENCH",
        "",
        "asl.json",
    ],
)
def test_dictionary_load_rejects_path_traversal_and_unknown(malicious: str) -> None:
    """Directory-traversal / unknown language values must be refused before
    they are ever turned into a filesystem path."""
    with pytest.raises(ValueError):
        Dictionary.load(malicious)


def test_dictionary_load_rejects_non_string_language() -> None:
    with pytest.raises(ValueError):
        Dictionary.load(None)  # type: ignore[arg-type]


def test_map_tokens_using_bundled_asl_dictionary() -> None:
    """Greedy longest-match against the real vocabulary.

    "thank you" is one WLASL gloss, so the two tokens must collapse into a
    single sign rather than emitting THANK and YOU separately.
    """
    d = Dictionary.load("ASL")
    signs = map_tokens(["hello", "thank", "you", "today"], d)
    ids = [s.sign_id for s in signs]
    assert "asl-hello-v1" in ids
    assert "asl-thank-you-v1" in ids
    assert "asl-today-v1" in ids
    assert "asl-you-v1" not in ids  # swallowed by the longer phrase


def test_to_sign_id_strips_punctuation_to_match_clip_filenames() -> None:
    """Regression: the mapper slug must match the clip converter's slug.

    Gloss `DR._HILLA_LIMAN` is stored as `dr-hilla-liman-v1.json`; a slug that
    kept the period produced `dr.-hilla-liman-v1`, which silently 404'd.
    """
    assert to_sign_id("GhSL", "DR._HILLA_LIMAN") == "ghsl-dr-hilla-liman-v1"
    assert to_sign_id("GhSL", "COTE_D'IVOIRE") == "ghsl-cote-d-ivoire-v1"


def test_map_tokens_skips_standalone_function_words() -> None:
    """Articles and copulas cost a full clip each and are unsigned anyway."""
    d = Dictionary("GhSL", {"doctor": "DOCTOR", "here": "HERE"})
    signs = map_tokens(["the", "doctor", "is", "here"], d)
    assert [s.gloss for s in signs] == ["DOCTOR", "HERE"]


def test_map_tokens_keeps_function_words_inside_a_phrase() -> None:
    """Filtering must not destroy multi-token entries that contain them.

    "a lot" is a single WLASL gloss; dropping the bare "a" first would leave
    "lot" and lose the sign entirely.
    """
    d = Dictionary("ASL", {"a lot": "A LOT", "of": "OF"})
    signs = map_tokens(["a", "lot"], d)
    assert [s.gloss for s in signs] == ["A LOT"]


# ── Fingerspelling ──────────────────────────────────────────────────────────


def test_fingerspells_an_unknown_word_when_every_letter_is_available() -> None:
    d = Dictionary("ASL", {"the": "THE"})
    alphabet = frozenset("abcdefghijklmnopqrstuvwxyz")
    signs = map_tokens(["kofi"], d, alphabet)
    assert [s.sign_id for s in signs] == ["asl-k-v1", "asl-o-v1", "asl-f-v1", "asl-i-v1"]
    assert all(s.is_fingerspell for s in signs)


def test_refuses_to_spell_when_a_letter_is_missing() -> None:
    """A guessed handshape is a WRONG letter, not an approximate one.

    This is the whole safety property: partial spelling would render "kofi"
    as "k-o-i", which is a different word confidently signed.
    """
    alphabet = frozenset("abcdefghijklmnopqrstuvwxyz") - {"f"}
    signs = map_tokens(["kofi"], Dictionary("ASL", {}), alphabet)
    assert signs == []


def test_spelling_is_off_without_an_alphabet() -> None:
    assert map_tokens(["kofi"], Dictionary("ASL", {})) == []


def test_lexical_sign_always_beats_spelling() -> None:
    d = Dictionary("ASL", {"water": "WATER"})
    signs = map_tokens(["water"], d, frozenset("abcdefghijklmnopqrstuvwxyz"))
    assert [s.sign_id for s in signs] == ["asl-water-v1"]
    assert not signs[0].is_fingerspell


def test_long_words_are_not_spelled() -> None:
    """Spelling 'revolutionary' costs 13 clips and loses the viewer."""
    alphabet = frozenset("abcdefghijklmnopqrstuvwxyz")
    assert map_tokens(["revolutionary"], Dictionary("ASL", {}), alphabet) == []


def test_every_unknown_word_in_an_utterance_is_spelled() -> None:
    """An utterance is rendered in full: each word is either signed or spelled.

    This budget was 1, so a sentence with two names dropped the second one
    silently. Dropping a name is not a smaller error than spelling it slowly,
    and the stale-sign queue already trims a run that overruns its media time,
    so the cap exists only to stop an unbounded run.
    """
    alphabet = frozenset("abcdefghijklmnopqrstuvwxyz")
    signs = map_tokens(["kofi", "yaw"], Dictionary("ASL", {}), alphabet)
    assert {s.source_tokens[0] for s in signs} == {"kofi", "yaw"}


def test_spelling_is_capped_per_utterance() -> None:
    """Past the cap, words are dropped rather than queueing minutes of letters."""
    alphabet = frozenset("abcdefghijklmnopqrstuvwxyz")
    words = [f"kofi{i}"[:4] + chr(ord("a") + i) for i in range(MAX_SPELLED_PER_UTTERANCE + 3)]
    signs = map_tokens(words, Dictionary("ASL", {}), alphabet)
    spelled = {s.source_tokens[0] for s in signs}
    assert len(spelled) == MAX_SPELLED_PER_UTTERANCE


def test_only_proper_nouns_are_spelled() -> None:
    """An interpreter spells names, not ordinary vocabulary.

    Without this restriction the ASR transcript "Ever tried" spelled out
    E-V-E-R, burning four clips on a word that is simply not in the lexicon.
    """
    alphabet = frozenset("abcdefghijklmnopqrstuvwxyz")
    d = Dictionary("ASL", {})
    assert map_tokens(["ever"], d, alphabet, spellable={"kofi"}) == []
    spelled = map_tokens(["kofi"], d, alphabet, spellable={"kofi"})
    assert [s.sign_id for s in spelled] == ["asl-k-v1", "asl-o-v1", "asl-f-v1", "asl-i-v1"]


def test_bundled_alphabet_matches_the_shipped_manifest() -> None:
    """The Lambda cannot see the clips, so it reads a snapshot of them.

    If this drifts from `dictionary/`, run backend/scripts/build-alphabets.py.
    """
    from fingerspell import bundled_alphabet

    asl = bundled_alphabet("ASL")
    assert asl, "ASL alphabet is empty - alphabets.json missing or unreadable"
    # GhSL inherited the ASL manual alphabet, so the two must match exactly.
    assert bundled_alphabet("GhSL") == asl
    # Case-insensitive, because callers pass the canonical "GhSL".
    assert bundled_alphabet("ghsl") == asl


def test_bundled_alphabet_is_empty_for_unknown_languages() -> None:
    """Failing closed: no alphabet means no spelling, never partial spelling."""
    from fingerspell import bundled_alphabet

    assert bundled_alphabet("BSL") == frozenset()
    assert bundled_alphabet("../../etc/passwd") == frozenset()
