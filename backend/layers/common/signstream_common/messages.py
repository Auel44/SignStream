"""Constants for messages on the wire.

The extension's TypeScript side keeps its own copy of these values in
`extension/src/shared/types.ts`. When you change one side you have to
change the other — kept as a written commit-time contract rather than
generated code, since we cannot import TS types into Python.
"""

from __future__ import annotations

# Client-facing WebSocket message types (in the `type` field of the JSON).
READY_TYPE = "ready"
TRANSCRIPT_TYPE = "transcript"
SIGN_ID_TYPE = "signId"
ERROR_TYPE = "error"

# EventBridge detail-types on the signstream-bus.
TRANSCRIPT_DETAIL_TYPE = "signstream.transcript"
SIGN_ID_DETAIL_TYPE = "signstream.signId"

# Sign languages the system will accept.
#
# BSL is deliberately absent. No public BSL keypoint dataset exists that we can
# ship — the dictionary holds a single placeholder clip — so accepting the
# language would mean advertising a translation the system cannot perform, and
# a Deaf user would see an avatar that stands still through every sentence.
# Refusing it at the boundary is the honest behaviour: the client cannot select
# it, and any request naming it is rejected exactly like an unknown language.
#
# To re-enable once a dataset is converted:
#   1. build the clips into dictionary/bsl/
#   2. regenerate the vocabulary (pose-generator/src/build_gloss_vocabulary.py)
#   3. add "BSL" back here and to mapper.VALID_LANGUAGES
#   4. restore the BSL entry in extension/src/shared/types.ts SIGN_LANGUAGES
SUPPORTED_SIGN_LANGUAGES = frozenset({"ASL", "GhSL"})

#: Recognised but not currently served. Kept separate so the reason for a
#: rejection can be specific ("not yet supported") rather than "unknown".
LOCKED_SIGN_LANGUAGES = frozenset({"BSL"})

VALID_SIGN_LANGUAGES = SUPPORTED_SIGN_LANGUAGES
