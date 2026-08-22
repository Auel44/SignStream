# ── SQS: audio-queue and its dead-letter queue ───────────────────────────────
#
# ws-audio-ingest enqueues onto audio-queue. asr consumes from it. Messages
# that fail 3 times land in audio-dlq and stop blocking the pipeline.

resource "aws_sqs_queue" "audio_dlq" {
  name                      = "${local.name_prefix}-audio-dlq"
  message_retention_seconds = 1209600 # 14 days — the max

  # Encrypt at rest. Messages carry base64 user speech (PII-adjacent), so we
  # enable SSE-SQS explicitly rather than relying on account defaults.
  sqs_managed_sse_enabled = true
}

resource "aws_sqs_queue" "audio" {
  name                       = "${local.name_prefix}-audio-queue"
  visibility_timeout_seconds = var.audio_queue_visibility_timeout_seconds
  message_retention_seconds  = 14400 # 4 hours — audio older than that is stale

  # Encrypt at rest — see the DLQ comment above.
  sqs_managed_sse_enabled = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.audio_dlq.arn
    maxReceiveCount     = var.audio_queue_max_receive_count
  })
}

# Enforce TLS in transit: deny any SQS action that is not over HTTPS.
resource "aws_sqs_queue_policy" "audio_tls_only" {
  queue_url = aws_sqs_queue.audio.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyNonTLS"
        Effect    = "Deny"
        Principal = "*"
        Action    = "sqs:*"
        Resource  = aws_sqs_queue.audio.arn
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      }
    ]
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "audio_dlq_allow" {
  queue_url = aws_sqs_queue.audio_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.audio.arn]
  })
}

# Publish the queue URL so the api stack (ws-audio-ingest) can find it.
resource "aws_ssm_parameter" "audio_queue_url" {
  name  = "${local.ssm_prefix}/async/audio_queue/url"
  type  = "String"
  value = aws_sqs_queue.audio.id
}

resource "aws_ssm_parameter" "audio_queue_arn" {
  name  = "${local.ssm_prefix}/async/audio_queue/arn"
  type  = "String"
  value = aws_sqs_queue.audio.arn
}

resource "aws_ssm_parameter" "audio_dlq_arn" {
  name  = "${local.ssm_prefix}/async/audio_dlq/arn"
  type  = "String"
  value = aws_sqs_queue.audio_dlq.arn
}
