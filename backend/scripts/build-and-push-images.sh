#!/usr/bin/env bash
# Build and push all six SignStream Lambda container images to ECR.
#
# Usage:
#   AWS_REGION=eu-west-1 TF_VAR_environment=staging ./scripts/build-and-push-images.sh
#
# ECR repositories are created by the storage Terraform stack. Run that
# first, then this. The image tag defaults to 'latest'; override with
# IMAGE_TAG=v1.2.3.

set -euo pipefail

: "${AWS_REGION:=eu-west-1}"
: "${TF_VAR_environment:=staging}"
: "${IMAGE_TAG:=latest}"
: "${PROJECT:=signstream}"

FUNCTIONS=(
  asr
  text-to-gloss
  health-warmer
  ws-connect
  ws-disconnect
  ws-audio-ingest
)

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "──▶ Logging in to ECR (${REGISTRY})"
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${REGISTRY}"

for fn in "${FUNCTIONS[@]}"; do
  repo="${PROJECT}-${TF_VAR_environment}-${fn}"
  image_uri="${REGISTRY}/${repo}:${IMAGE_TAG}"

  echo ""
  echo "──▶ Building ${fn}"
  # Build context = backend/ so the Dockerfile can reach layers/common/.
  docker build \
    --file "${BACKEND_DIR}/functions/${fn}/Dockerfile" \
    --tag "${image_uri}" \
    "${BACKEND_DIR}"

  echo "──▶ Pushing ${image_uri}"
  docker push "${image_uri}"
done

echo ""
echo "──▶ Done. All six images tagged ${IMAGE_TAG} pushed to ${REGISTRY}."
