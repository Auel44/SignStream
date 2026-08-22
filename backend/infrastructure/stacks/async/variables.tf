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

variable "websocket_api_id" {
  description = <<-EOT
    ID of the WebSocket API the asr / text-to-gloss Lambdas push messages
    back to. Leave as "*" on the very first deploy (the api stack has not
    created the API yet). After the first full deploy, set this to the real
    API id (terraform output websocket_api_id in the api stack) and re-apply
    so the execute-api:ManageConnections grant is scoped to exactly one API
    instead of every API in the account.
  EOT
  type    = string
  default = "*"
}

variable "asr_memory_mb" {
  description = "Memory allocated to the asr Lambda (drives CPU too)."
  type        = number
  default     = 2048
}

variable "asr_timeout_seconds" {
  description = "asr Lambda timeout. Longer than the frame length so partial ASR can accumulate context."
  type        = number
  default     = 30
}

variable "asr_model" {
  description = <<-EOT
    Which ASR engine to run in the asr Lambda:
      - moonshine               (DEFAULT — base Moonshine ONNX, fast on CPU, MIT,
                                 no training required)
      - stub                    (dev / demo, no ML)
      - moonshine-african       (Moonshine fine-tuned on AfriSpeech-200 — NOT
                                 available: the public Moonshine package is
                                 inference-only and exposes no training API, so
                                 a fine-tuned artefact cannot be produced yet.
                                 Kept as a slot for future work.)
      - parakeet-tdt-streaming  (roadmap — GPU; not yet implemented)
      - mms                     (roadmap; needs ECS/Fargate hosting)
  EOT
  type    = string
  default = "moonshine"

  validation {
    condition = contains(
      ["stub", "moonshine", "moonshine-african"],
      var.asr_model,
    )
    error_message = "asr_model must currently be one of: stub, moonshine, moonshine-african."
  }
}

variable "asr_moonshine_model" {
  description = <<-EOT
    Preset for asr_model=moonshine: "moonshine/tiny" (fastest) or
    "moonshine/base" (more accurate). Ignored for moonshine-african.
  EOT
  type    = string
  default = "moonshine/base"
}

variable "asr_moonshine_model_path" {
  description = <<-EOT
    Local directory (inside the Lambda container) of the fine-tuned ONNX
    model files. Required when asr_model = moonshine-african. Example:
      /opt/model/moonshine-african   (baked into the Docker image)
  EOT
  type    = string
  default = ""
}

variable "text_to_gloss_memory_mb" {
  description = "Memory for the text-to-gloss Lambda."
  type        = number
  default     = 512
}

variable "audio_queue_visibility_timeout_seconds" {
  description = "How long an SQS message stays invisible after being received. Must exceed asr_timeout_seconds."
  type        = number
  default     = 60
}

variable "audio_queue_max_receive_count" {
  description = "How many times a message may fail before landing in the DLQ."
  type        = number
  default     = 3
}

variable "warmer_schedule" {
  description = "Rate at which the health-warmer fires (EventBridge Scheduler expression)."
  type        = string
  default     = "rate(5 minutes)"
}
