resource "aws_cloudwatch_log_group" "text_to_gloss" {
  name              = "/aws/lambda/${local.name_prefix}-text-to-gloss"
  retention_in_days = 14
}

resource "aws_lambda_function" "text_to_gloss" {
  function_name = "${local.name_prefix}-text-to-gloss"
  role          = aws_iam_role.text_to_gloss.arn
  package_type  = "Image"
  image_uri     = "${data.aws_ssm_parameter.ecr_text_to_gloss.value}:${var.image_tag}"

  memory_size   = var.text_to_gloss_memory_mb
  timeout       = 15
  architectures = ["x86_64"]

  environment {
    variables = {
      WEBSOCKET_ENDPOINT = local.websocket_management_url
      EVENT_BUS_NAME     = aws_cloudwatch_event_bus.signstream.name
      EVENT_SOURCE       = "signstream.text-to-gloss"
      LOG_LEVEL          = "INFO"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.text_to_gloss,
    aws_iam_role_policy.text_to_gloss,
    aws_iam_role_policy_attachment.text_to_gloss_basic,
  ]
}

# EventBridge target: transcript rule -> text-to-gloss Lambda.
resource "aws_cloudwatch_event_target" "text_to_gloss" {
  event_bus_name = aws_cloudwatch_event_bus.signstream.name
  rule           = aws_cloudwatch_event_rule.transcript.name
  target_id      = "text-to-gloss"
  arn            = aws_lambda_function.text_to_gloss.arn
}

resource "aws_lambda_permission" "eventbridge_invokes_text_to_gloss" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.text_to_gloss.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.transcript.arn
}
