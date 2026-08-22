resource "aws_cloudwatch_log_group" "ws_audio_ingest" {
  name              = "/aws/lambda/${local.name_prefix}-ws-audio-ingest"
  retention_in_days = 14
}

resource "aws_lambda_function" "ws_audio_ingest" {
  function_name = "${local.name_prefix}-ws-audio-ingest"
  role          = aws_iam_role.ws_audio_ingest.arn
  package_type  = "Image"
  image_uri     = "${data.aws_ssm_parameter.ecr_ws_audio_ingest.value}:${var.image_tag}"

  memory_size   = var.route_lambda_memory_mb
  timeout       = var.route_lambda_timeout_seconds
  architectures = ["x86_64"]

  environment {
    variables = {
      CONNECTIONS_TABLE = data.aws_ssm_parameter.connections_table_name.value
      AUDIO_QUEUE_URL   = data.aws_ssm_parameter.audio_queue_url.value
      LOG_LEVEL         = "INFO"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.ws_audio_ingest,
    aws_iam_role_policy.ws_audio_ingest,
    aws_iam_role_policy_attachment.ws_audio_ingest_basic,
  ]
}

resource "aws_lambda_permission" "apigw_invokes_ws_audio_ingest" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws_audio_ingest.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/*"
}
