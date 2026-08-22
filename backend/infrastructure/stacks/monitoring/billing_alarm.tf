# ── Billing alarm ────────────────────────────────────────────────────────────
#
# The number-one cost guardrail. Fires when estimated monthly charges exceed
# `var.billing_alarm_threshold_usd`. Billing metrics only publish to
# us-east-1, hence the provider alias.

resource "aws_cloudwatch_metric_alarm" "billing" {
  provider = aws.us_east_1

  alarm_name          = "${local.name_prefix}-billing-over-threshold"
  alarm_description   = "Estimated monthly AWS charges exceeded ${var.billing_alarm_threshold_usd} USD."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "EstimatedCharges"
  namespace           = "AWS/Billing"
  period              = 21600 # 6 hours — billing metrics update every ~6h
  statistic           = "Maximum"
  threshold           = var.billing_alarm_threshold_usd
  treat_missing_data  = "notBreaching"

  dimensions = {
    Currency = "USD"
  }

  # The alerts SNS topic is regional; we need a us-east-1 copy for this alarm.
  alarm_actions = [aws_sns_topic.alerts_us_east_1.arn]
}

resource "aws_sns_topic" "alerts_us_east_1" {
  provider = aws.us_east_1
  name     = "${local.name_prefix}-alerts-us-east-1"
}

resource "aws_sns_topic_subscription" "alerts_us_east_1_email" {
  count     = var.alert_email == "" ? 0 : 1
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.alerts_us_east_1.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
