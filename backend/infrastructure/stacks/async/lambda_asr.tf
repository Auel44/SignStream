resource "aws_cloudwatch_log_group" "asr" {
  name              = "/aws/lambda/${local.name_prefix}-asr"
  retention_in_days = 14
}

resource "aws_lambda_function" "asr" {
  function_name = "${local.name_prefix}-asr"
  role          = aws_iam_role.asr.arn
  package_type  = "Image"
  image_uri     = "${data.aws_ssm_parameter.ecr_asr.value}:${var.image_tag}"

  memory_size = var.asr_memory_mb
  timeout     = var.asr_timeout_seconds
  architectures = ["x86_64"]

  environment {
    variables = {
      ASR_MODEL                = var.asr_model
      ASR_MOONSHINE_MODEL      = var.asr_moonshine_model
      ASR_MOONSHINE_MODEL_PATH = var.asr_moonshine_model_path
      WEBSOCKET_ENDPOINT       = local.websocket_management_url
      EVENT_BUS_NAME           = aws_cloudwatch_event_bus.signstream.name
      EVENT_SOURCE             = "signstream.asr"
      SESSION_CACHE_SIZE       = "128"
      SESSION_TTL_SECONDS      = "600"
      LOG_LEVEL                = "INFO"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.asr,
    aws_iam_role_policy.asr,
    aws_iam_role_policy_attachment.asr_basic,
  ]
}

# Wire SQS -> asr so messages flow automatically.
resource "aws_lambda_event_source_mapping" "asr_sqs" {
  event_source_arn                   = aws_sqs_queue.audio.arn
  function_name                      = aws_lambda_function.asr.arn
  batch_size                         = 1
  maximum_batching_window_in_seconds = 0
  function_response_types            = ["ReportBatchItemFailures"]
}
