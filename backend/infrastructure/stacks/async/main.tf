provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

data "aws_caller_identity" "current" {}

locals {
  name_prefix = "${var.project}-${var.environment}"
  common_tags = {
    Project     = var.project
    Environment = var.environment
    Stack       = "async"
    ManagedBy   = "terraform"
  }

  ssm_prefix = "/${var.project}/${var.environment}"
}

# ── Cross-stack lookups (from storage/) ──────────────────────────────────────

data "aws_ssm_parameter" "connections_table_name" {
  name = "${local.ssm_prefix}/storage/connections/table_name"
}

data "aws_ssm_parameter" "connections_table_arn" {
  name = "${local.ssm_prefix}/storage/connections/table_arn"
}

data "aws_ssm_parameter" "ecr_asr" {
  name = "${local.ssm_prefix}/storage/ecr/asr"
}

data "aws_ssm_parameter" "ecr_text_to_gloss" {
  name = "${local.ssm_prefix}/storage/ecr/text-to-gloss"
}

data "aws_ssm_parameter" "ecr_health_warmer" {
  name = "${local.ssm_prefix}/storage/ecr/health-warmer"
}

# ── Optional cross-stack lookup (from api/) ──────────────────────────────────
#
# On the very first deploy the api stack has not created the WebSocket API
# yet, so this SSM parameter does not exist. We use `try()` to fall back to
# an empty string; the ML Lambdas will boot but push_to_client() will log
# and return False until a second `terraform apply` picks up the real URL.

data "aws_ssm_parameters_by_path" "api_lookup" {
  path = "${local.ssm_prefix}/api/"
}

locals {
  # Extract the wss endpoint if it exists; otherwise ""
  websocket_management_url = try(
    {
      for i, name in data.aws_ssm_parameters_by_path.api_lookup.names :
      name => data.aws_ssm_parameters_by_path.api_lookup.values[i]
    }["${local.ssm_prefix}/api/websocket/management_url"],
    ""
  )
}
