#!/usr/bin/env bash
# End-to-end deploy: storage → images → async → api → async (again) → monitoring.
#
# The second async apply picks up the WebSocket URL that the api stack
# writes to SSM, resolving the circular dependency between the ML-side
# Lambdas and the API Gateway management URL.
#
# Usage:
#   ./scripts/deploy.sh staging
#   ./scripts/deploy.sh production
#
# Env overrides:
#   IMAGE_TAG=v1.2.3   AWS_REGION=eu-west-1   AUTO_APPROVE=1

set -euo pipefail

ENVIRONMENT="${1:-staging}"
if [[ "${ENVIRONMENT}" != "staging" && "${ENVIRONMENT}" != "production" ]]; then
  echo "usage: $0 [staging|production]" >&2
  exit 1
fi

: "${AWS_REGION:=eu-west-1}"
: "${IMAGE_TAG:=latest}"

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STACKS_DIR="${BACKEND_DIR}/infrastructure/stacks"

APPROVE_FLAG=""
if [[ "${AUTO_APPROVE:-0}" == "1" ]]; then
  APPROVE_FLAG="-auto-approve"
fi

apply_stack() {
  local name="$1"
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "▶ terraform apply ${name} (env=${ENVIRONMENT})"
  echo "════════════════════════════════════════════════════════════════"
  (
    cd "${STACKS_DIR}/${name}"
    terraform init -upgrade
    terraform apply ${APPROVE_FLAG} \
      -var "aws_region=${AWS_REGION}" \
      -var "environment=${ENVIRONMENT}" \
      -var "image_tag=${IMAGE_TAG}"
  )
}

echo "▶ Step 1/5 — storage stack"
(
  cd "${STACKS_DIR}/storage"
  terraform init -upgrade
  terraform apply ${APPROVE_FLAG} \
    -var "aws_region=${AWS_REGION}" \
    -var "environment=${ENVIRONMENT}"
)

echo ""
echo "▶ Step 1b/5 — upload sign clips to the dictionary CDN"
# Runs right after storage because that stack creates the bucket, and before
# anything else because a deployed backend that emits sign ids the CDN cannot
# serve renders nothing. Unchanged clips are skipped, so re-deploys are cheap.
python "${BACKEND_DIR}/scripts/upload-dictionary.py" \
  --environment "${ENVIRONMENT}" \
  --region "${AWS_REGION}"

echo ""
echo "▶ Step 2/5 — build & push Lambda images"
AWS_REGION="${AWS_REGION}" \
TF_VAR_environment="${ENVIRONMENT}" \
IMAGE_TAG="${IMAGE_TAG}" \
  "${BACKEND_DIR}/scripts/build-and-push-images.sh"

echo ""
echo "▶ Step 3/5 — async stack (first pass, WebSocket URL still empty)"
apply_stack async

echo ""
echo "▶ Step 4/5 — api stack"
apply_stack api

echo ""
echo "▶ Step 5a/5 — async stack (second pass, picks up WebSocket URL)"
apply_stack async

echo ""
echo "▶ Step 5b/5 — monitoring stack"
(
  cd "${STACKS_DIR}/monitoring"
  terraform init -upgrade
  terraform apply ${APPROVE_FLAG} \
    -var "aws_region=${AWS_REGION}" \
    -var "environment=${ENVIRONMENT}"
)

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "✔ SignStream ${ENVIRONMENT} deployed."
echo ""
echo "Build the extension against this deployment with:"
echo ""
echo -n "  VITE_WS_ENDPOINT="
(cd "${STACKS_DIR}/api" && terraform output -raw websocket_client_url)
echo ""
echo -n "  VITE_DICTIONARY_BASE_URL="
(cd "${STACKS_DIR}/storage" && terraform output -raw dictionary_base_url)
echo ""
echo ""
echo "  (or paste both into the extension's Settings screen at runtime)"
