variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "eu-west-1"
}

variable "project" {
  description = "Short project name; prefixed onto every resource."
  type        = string
  default     = "signstream"
}

variable "environment" {
  description = "Environment tag (staging | production)."
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be either 'staging' or 'production'."
  }
}

variable "connection_ttl_hours" {
  description = <<-EOT
    Idle TTL on the DynamoDB Connections table. DynamoDB evicts rows whose
    expiresAt attribute is older than now. Safety net for crashed clients
    whose $disconnect event never fires.
  EOT
  type        = number
  default     = 1
}
