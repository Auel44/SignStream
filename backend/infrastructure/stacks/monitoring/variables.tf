variable "aws_region" {
  description = "AWS region for regional resources (dashboard, alarms)."
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

variable "billing_alarm_threshold_usd" {
  description = "Fire the CloudWatch billing alarm above this monthly amount."
  type        = number
  default     = 5
}

variable "alert_email" {
  description = "Email address that receives billing and DLQ alerts. Leave empty to skip SNS subscriptions."
  type        = string
  default     = ""
}

variable "dlq_alarm_threshold_messages" {
  description = "Number of DLQ messages that fires the DLQ-depth alarm."
  type        = number
  default     = 1
}
