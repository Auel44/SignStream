#!/usr/bin/env bash
# Destroy all four SignStream stacks in the reverse of deploy order.
#
# Usage:
#   ./scripts/teardown.sh staging
#
# Prompts before each destroy. Pass AUTO_APPROVE=1 to skip prompts.

set -euo pipefail

ENVIRONMENT="${1:-staging}"
if [[ "${ENVIRONMENT}" != "staging" && "${ENVIRONMENT}" != "production" ]]; then
  echo "usage: $0 [staging|production]" >&2
  exit 1
fi

: "${AWS_REGION:=eu-west-1}"

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STACKS_DIR="${BACKEND_DIR}/infrastructure/stacks"

APPROVE_FLAG=""
if [[ "${AUTO_APPROVE:-0}" == "1" ]]; then
  APPROVE_FLAG="-auto-approve"
fi

# Reverse of deploy order — monitoring first, storage last.
STACKS=(monitoring api async storage)

for stack in "${STACKS[@]}"; do
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "▶ terraform destroy ${stack} (env=${ENVIRONMENT})"
  echo "════════════════════════════════════════════════════════════════"
  (
    cd "${STACKS_DIR}/${stack}"
    terraform init -upgrade
    terraform destroy ${APPROVE_FLAG} \
      -var "aws_region=${AWS_REGION}" \
      -var "environment=${ENVIRONMENT}"
  )
done

echo ""
echo "✔ SignStream ${ENVIRONMENT} torn down."
echo ""
echo "Note: ECR images and DynamoDB point-in-time recovery backups may"
echo "still exist. Check the AWS console if you want a clean-slate."
