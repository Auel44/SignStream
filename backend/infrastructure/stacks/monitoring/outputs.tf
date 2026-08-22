output "dashboard_url" {
  description = "Direct URL to the CloudWatch dashboard."
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${aws_cloudwatch_dashboard.signstream.dashboard_name}"
}

output "alerts_sns_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
