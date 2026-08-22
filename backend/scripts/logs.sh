#!/usr/bin/env bash
# Tail a Lambda's CloudWatch logs.
#
# Usage:
#   ./scripts/logs.sh <function-short-name> [--since 5m]
#
# Where <function-short-name> is one of:
#   asr, text-to-gloss, health-warmer,
#   ws-connect, ws-disconnect, ws-audio-ingest

set -euo pipefail

: "${AWS_REGION:=eu-west-1}"
: "${TF_VAR_environment:=staging}"
: "${PROJECT:=signstream}"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <function-short-name> [--since 5m]" >&2
  exit 1
fi

FUNCTION="$1"
shift

VALID=("asr" "text-to-gloss" "health-warmer" "ws-connect" "ws-disconnect" "ws-audio-ingest")
found=0
for v in "${VALID[@]}"; do
  if [[ "$v" == "$FUNCTION" ]]; then
    found=1
    break
  fi
done
if [[ $found -eq 0 ]]; then
  echo "Unknown function: $FUNCTION" >&2
  echo "Valid names: ${VALID[*]}" >&2
  exit 1
fi

LOG_GROUP="/aws/lambda/${PROJECT}-${TF_VAR_environment}-${FUNCTION}"

echo "▶ Tailing ${LOG_GROUP} in ${AWS_REGION}"
echo "▶ Ctrl-C to stop"
echo ""

aws logs tail "${LOG_GROUP}" \
  --region "${AWS_REGION}" \
  --follow \
  --format short \
  "$@"
