provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

locals {
  name_prefix = "${var.project}-${var.environment}"
  common_tags = {
    Project     = var.project
    Environment = var.environment
    Stack       = "storage"
    ManagedBy   = "terraform"
  }

  # The six Lambda images — each gets its own ECR repository so image
  # promotions can be scheduled independently per function.
  lambda_functions = [
    "asr",
    "text-to-gloss",
    "health-warmer",
    "ws-connect",
    "ws-disconnect",
    "ws-audio-ingest",
  ]
}

data "aws_caller_identity" "current" {}

# ── DynamoDB: Connections table ───────────────────────────────────────────────
#
# One row per live WebSocket session. See functions/ws-connect/README.md
# for the schema and functions/ws-audio-ingest/handler.py for how the
# sequence counter is atomically incremented per audio frame.

resource "aws_dynamodb_table" "connections" {
  name         = "${local.name_prefix}-connections"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "connectionId"

  attribute {
    name = "connectionId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  # Encrypt at rest explicitly (AWS-managed KMS key — free). DynamoDB is
  # encrypted by default with an AWS-owned key; declaring this makes the
  # posture auditable and upgradeable to a customer-managed key later.
  server_side_encryption {
    enabled = true
  }

  point_in_time_recovery {
    enabled = var.environment == "production"
  }

  tags = {
    Name = "${local.name_prefix}-connections"
  }
}

# ── ECR: one image repository per Lambda ─────────────────────────────────────

resource "aws_ecr_repository" "lambda" {
  for_each             = toset(local.lambda_functions)
  name                 = "${local.name_prefix}-${each.value}"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  # Set to true in staging so `terraform destroy` can wipe non-empty repos.
  # Never true in production.
  force_delete = var.environment != "production"
}

# Keep only the latest 5 tagged images per repo — image storage cost adds
# up fast otherwise.
resource "aws_ecr_lifecycle_policy" "lambda" {
  for_each   = aws_ecr_repository.lambda
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep only the latest 5 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 5
        }
        action = { type = "expire" }
      }
    ]
  })
}

# ── SSM: publish outputs the other stacks read ────────────────────────────────
#
# Using SSM parameters (rather than terraform_remote_state) means each stack
# owns its own state file and can be applied independently.

resource "aws_ssm_parameter" "connections_table_name" {
  name  = "/${var.project}/${var.environment}/storage/connections/table_name"
  type  = "String"
  value = aws_dynamodb_table.connections.name
}

resource "aws_ssm_parameter" "connections_table_arn" {
  name  = "/${var.project}/${var.environment}/storage/connections/table_arn"
  type  = "String"
  value = aws_dynamodb_table.connections.arn
}

resource "aws_ssm_parameter" "ecr_repo_url" {
  for_each = aws_ecr_repository.lambda

  name  = "/${var.project}/${var.environment}/storage/ecr/${each.key}"
  type  = "String"
  value = each.value.repository_url
}
