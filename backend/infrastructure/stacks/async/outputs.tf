output "audio_queue_url" {
  value       = aws_sqs_queue.audio.id
  description = "URL of the audio-queue that ws-audio-ingest posts to."
}

output "audio_queue_arn" {
  value       = aws_sqs_queue.audio.arn
  description = "ARN of the audio-queue (for IAM in api stack)."
}

output "audio_dlq_arn" {
  value       = aws_sqs_queue.audio_dlq.arn
  description = "ARN of the audio dead-letter queue (monitored by the monitoring stack)."
}

output "event_bus_name" {
  value       = aws_cloudwatch_event_bus.signstream.name
  description = "Name of the signstream EventBridge bus."
}

output "asr_lambda_arn" {
  value = aws_lambda_function.asr.arn
}

output "text_to_gloss_lambda_arn" {
  value = aws_lambda_function.text_to_gloss.arn
}

output "health_warmer_lambda_arn" {
  value = aws_lambda_function.health_warmer.arn
}
