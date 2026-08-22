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
    Stack       = "api"
    ManagedBy   = "terraform"
  }
  ssm_prefix = "/${var.project}/${var.environment}"
}

# ── Cross-stack lookups ──────────────────────────────────────────────────────

data "aws_ssm_parameter" "connections_table_name" {
  name = "${local.ssm_prefix}/storage/connections/table_name"
}

data "aws_ssm_parameter" "connections_table_arn" {
  name = "${local.ssm_prefix}/storage/connections/table_arn"
}

data "aws_ssm_parameter" "audio_queue_url" {
  name = "${local.ssm_prefix}/async/audio_queue/url"
}

data "aws_ssm_parameter" "audio_queue_arn" {
  name = "${local.ssm_prefix}/async/audio_queue/arn"
}

data "aws_ssm_parameter" "ecr_ws_connect" {
  name = "${local.ssm_prefix}/storage/ecr/ws-connect"
}

data "aws_ssm_parameter" "ecr_ws_disconnect" {
  name = "${local.ssm_prefix}/storage/ecr/ws-disconnect"
}

data "aws_ssm_parameter" "ecr_ws_audio_ingest" {
  name = "${local.ssm_prefix}/storage/ecr/ws-audio-ingest"
}
