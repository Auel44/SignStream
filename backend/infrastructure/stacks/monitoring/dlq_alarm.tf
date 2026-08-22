# ── DLQ depth alarm ──────────────────────────────────────────────────────────
#
# If messages start landing in the DLQ, something upstream is failing more
# than the maxReceiveCount tolerance. Fires as soon as the DLQ has any
# message.

# The DLQ ARN comes from async's SSM parameter — split it to get the queue name.
locals {
  audio_dlq_name = element(split(":", data.aws_ssm_parameter.audio_dlq_arn.value), 5)
}

resource "aws_cloudwatch_metric_alarm" "audio_dlq_depth" {
  alarm_name          = "${local.name_prefix}-audio-dlq-non-empty"
  alarm_description   = "Messages landing in audio-dlq — inspect and replay."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Sum"
  threshold           = var.dlq_alarm_threshold_messages
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = local.audio_dlq_name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}
