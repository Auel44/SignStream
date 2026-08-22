variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "eu-west-1"
}

variable "project" {
  description = "Short project name."
  type        = string
  default     = "signstream"
}

variable "environment" {
  description = "Environment tag (staging | production)."
  type        = string
  default     = "staging"
}

variable "image_tag" {
  description = "Container image tag to deploy for each Lambda."
  type        = string
  default     = "latest"
}

variable "stage_name" {
  description = "API Gateway WebSocket stage (appears in the wss URL)."
  type        = string
  default     = "prod"
}

variable "route_lambda_memory_mb" {
  description = "Memory for the tiny WebSocket route Lambdas."
  type        = number
  default     = 256
}

variable "route_lambda_timeout_seconds" {
  description = "Timeout for the WebSocket route Lambdas."
  type        = number
  default     = 10
}

variable "throttling_rate_limit" {
  description = <<-EOT
    Steady-state requests/second the WebSocket API accepts across ALL clients.
    The default is sized for a small pilot: one active speaker streams ~4
    audio frames/second, so 40 rps ≈ 10 concurrent speakers. Raise for
    production. Kept deliberately low because the API is unauthenticated and
    every accepted frame triggers paid ASR inference — this cap is the primary
    guardrail against cost-abuse / denial-of-wallet.
  EOT
  type    = number
  default = 40
}

variable "throttling_burst_limit" {
  description = "Maximum request burst the WebSocket API absorbs above the steady rate."
  type        = number
  default     = 80
}
