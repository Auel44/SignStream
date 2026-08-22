# ── One dashboard covering every Lambda + the audio queue ────────────────────

locals {
  lambda_names = [
    "${local.name_prefix}-ws-connect",
    "${local.name_prefix}-ws-disconnect",
    "${local.name_prefix}-ws-audio-ingest",
    "${local.name_prefix}-asr",
    "${local.name_prefix}-text-to-gloss",
    "${local.name_prefix}-health-warmer",
  ]

  # Metric widgets per Lambda: invocations, errors, duration
  invocation_metrics = [
    for name in local.lambda_names :
    ["AWS/Lambda", "Invocations", "FunctionName", name]
  ]
  error_metrics = [
    for name in local.lambda_names :
    ["AWS/Lambda", "Errors", "FunctionName", name]
  ]
  duration_metrics = [
    for name in local.lambda_names :
    ["AWS/Lambda", "Duration", "FunctionName", name, { stat = "Average" }]
  ]
}

resource "aws_cloudwatch_dashboard" "signstream" {
  dashboard_name = "${local.name_prefix}-overview"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title   = "Lambda invocations"
          metrics = local.invocation_metrics
          region  = var.aws_region
          stat    = "Sum"
          period  = 300
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title   = "Lambda errors"
          metrics = local.error_metrics
          region  = var.aws_region
          stat    = "Sum"
          period  = 300
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title   = "Lambda average duration (ms)"
          metrics = local.duration_metrics
          region  = var.aws_region
          period  = 300
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title = "Audio queue backlog"
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", "${local.name_prefix}-audio-queue"],
            [".", "ApproximateAgeOfOldestMessage", ".", "."],
          ]
          region = var.aws_region
          period = 60
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title = "Audio DLQ depth"
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", local.audio_dlq_name],
          ]
          region = var.aws_region
          period = 60
        }
      },
    ]
  })
}
