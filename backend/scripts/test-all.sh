#!/usr/bin/env bash
# Run every Python test suite in the backend.
#
# Exits non-zero as soon as one suite fails so CI stops early.

set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# The Lambda functions import `signstream_common`, which is deployed as a
# Lambda layer rather than a pip package. At runtime AWS mounts it on the
# path; locally we have to add it ourselves or every handler test fails at
# import. Prepended so it wins over a stale installed copy.
export PYTHONPATH="${BACKEND_DIR}/layers/common${PYTHONPATH:+:${PYTHONPATH}}"

TARGETS=(
  "layers/common"
  "functions/asr"
  "functions/text-to-gloss"
  "functions/health-warmer"
  "functions/ws-connect"
  "functions/ws-disconnect"
  "functions/ws-audio-ingest"
)

total_passed=0
total_failed=0

for target in "${TARGETS[@]}"; do
  echo ""
  echo "══ ${target} ═════════════════════════════════════════════"
  (
    cd "${BACKEND_DIR}/${target}"
    python -m pytest -q --tb=short
  ) && total_passed=$((total_passed + 1)) \
    || { total_failed=$((total_failed + 1)); echo "❌ ${target} FAILED"; }
done

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "Summary: ${total_passed} suite(s) passed, ${total_failed} failed"
echo "════════════════════════════════════════════════════════════════"

if [[ ${total_failed} -gt 0 ]]; then
  exit 1
fi
