output "connections_table_name" {
  description = "Name of the DynamoDB Connections table."
  value       = aws_dynamodb_table.connections.name
}

output "connections_table_arn" {
  description = "ARN of the DynamoDB Connections table."
  value       = aws_dynamodb_table.connections.arn
}

output "ecr_repository_urls" {
  description = "Map of Lambda function name -> ECR repository URL."
  value       = { for k, v in aws_ecr_repository.lambda : k => v.repository_url }
}

output "dictionary_bucket_name" {
  description = "S3 bucket holding the sign clips. Target for scripts/upload-dictionary.py."
  value       = aws_s3_bucket.dictionary.id
}

output "dictionary_base_url" {
  description = <<-EOT
    CloudFront origin for sign clips. Set this as VITE_DICTIONARY_BASE_URL
    before building the extension, or paste it into the extension's settings
    screen at runtime.
  EOT
  value       = "https://${aws_cloudfront_distribution.dictionary.domain_name}"
}
