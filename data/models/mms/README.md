# Meta MMS — Massively Multilingual Speech (Future)

Meta AI's **Massively Multilingual Speech** model supports ASR for
**1,100+ languages** including several Ghanaian ones — **Akan (Twi),
Ewe, Ga, Dagbani** — that neither Moonshine nor Parakeet can transcribe
today.

**Not yet integrated.** This directory exists as a placeholder for the
v3+ roadmap item where SignStream expands from English-only to local
Ghanaian audio (Twi YouTube tutorials, Akan-language news, etc.).

## Why it's future work

1. **Model size:** the smallest useful MMS variant is ~1 B parameters.
   That is packageable in a Lambda container image but bumps cold-start
   time to ~30 s. Practical solution is to host MMS on ECS/Fargate
   rather than Lambda for languages where the traffic justifies a
   persistent container.
2. **Language identification:** MMS transcribes one language at a time
   and needs to know which. A separate language-ID pass is required
   before MMS is invoked — MediaPipe has nothing to say about audio, so
   this would be another small model (e.g. Meta's own MMS-LID language
   identifier).
3. **Dictionary work:** to be useful, the extension needs GhSL sign
   coverage for Twi/Ewe vocabulary too. That is human data-collection
   work in the `dictionary/` folder — larger than a code change.

## Source

- Repository: [github.com/facebookresearch/fairseq/tree/main/examples/mms](https://github.com/facebookresearch/fairseq/tree/main/examples/mms)
- HuggingFace: `facebook/mms-1b-all` (ASR head for all supported
  languages)
- Licence: CC-BY-NC-4.0 (research + non-commercial) — check the
  original card before commercial use.

## When it makes sense to add

Trigger for building MMS integration:

- Users request Twi / Ewe / Ga content transcription.
- OR a research collaboration wants a Ghanaian-language ASR baseline.
- OR SignStream demonstrably plateaus on English-only content.

Until then, the `asr` Lambda uses Moonshine (baseline or African-tuned).

## Approximate integration sketch (for when the time comes)

1. Add an ECS/Fargate service running MMS behind an internal HTTPS
   endpoint. Fargate because 1 B params does not fit Lambda memory
   comfortably and would time out at cold start.
2. Add an `MmsEngine` class in `backend/functions/asr/asr_engine.py`
   that POSTs audio chunks to that endpoint rather than running
   inference locally.
3. Add a language-detection step (Meta's MMS-LID identifier) before
   dispatching English vs. Twi/Ewe audio.
4. Extend `data/models/mms/` with any language-specific fine-tuning
   artefacts.

## Directory contents right now

Empty. This README plus the parent `data/models/README.md` are the only
files. No model weights are downloaded until integration begins.
