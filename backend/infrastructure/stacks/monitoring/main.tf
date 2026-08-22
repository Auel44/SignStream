provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

# AWS billing metrics only exist in us-east-1 — a separate provider alias
# is required for the billing alarm.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

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
    Stack       = "monitoring"
    ManagedBy   = "terraform"
  }
  ssm_prefix = "/${var.project}/${var.environment}"
}

# Cross-stack lookups: DLQ ARN and function names.
data "aws_ssm_parameter" "audio_dlq_arn" {
  name = "${local.ssm_prefix}/async/audio_dlq/arn"
}
