resource "aws_cloudwatch_log_group" "ws_disconnect" {
  name              = "/aws/lambda/${local.name_prefix}-ws-disconnect"
  retention_in_days = 14
}

resource "aws_lambda_function" "ws_disconnect" {
  function_name = "${local.name_prefix}-ws-disconnect"
  role          = aws_iam_role.ws_disconnect.arn
  package_type  = "Image"
  image_uri     = "${data.aws_ssm_parameter.ecr_ws_disconnect.value}:${var.image_tag}"

  memory_size   = var.route_lambda_memory_mb
  timeout       = var.route_lambda_timeout_seconds
  architectures = ["x86_64"]

  environment {
    variables = {
      CONNECTIONS_TABLE = data.aws_ssm_parameter.connections_table_name.value
      LOG_LEVEL         = "INFO"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.ws_disconnect,
    aws_iam_role_policy.ws_disconnect,
    aws_iam_role_policy_attachment.ws_disconnect_basic,
  ]
}

resource "aws_lambda_permission" "apigw_invokes_ws_disconnect" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws_disconnect.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/*"
}
