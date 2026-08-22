# ── API Gateway v2 WebSocket API ─────────────────────────────────────────────

resource "aws_apigatewayv2_api" "ws" {
  name                       = "${local.name_prefix}-ws"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
  description                = "SignStream client audio/control WebSocket."
}

# ── Route integrations ───────────────────────────────────────────────────────

resource "aws_apigatewayv2_integration" "ws_connect" {
  api_id                    = aws_apigatewayv2_api.ws.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.ws_connect.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
  passthrough_behavior      = "WHEN_NO_MATCH"
}

resource "aws_apigatewayv2_integration" "ws_disconnect" {
  api_id                    = aws_apigatewayv2_api.ws.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.ws_disconnect.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
  passthrough_behavior      = "WHEN_NO_MATCH"
}

resource "aws_apigatewayv2_integration" "ws_audio_ingest" {
  api_id           = aws_apigatewayv2_api.ws.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.ws_audio_ingest.invoke_arn

  # Binary frames arrive on the default route; API Gateway will base64-
  # encode them into event.body with event.isBase64Encoded=true.
  content_handling_strategy = "CONVERT_TO_TEXT"
  passthrough_behavior      = "WHEN_NO_MATCH"
}

# ── Routes ───────────────────────────────────────────────────────────────────

resource "aws_apigatewayv2_route" "connect" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.ws_connect.id}"
}

resource "aws_apigatewayv2_route" "disconnect" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.ws_disconnect.id}"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.ws_audio_ingest.id}"
}

# ── Deployment + Stage ───────────────────────────────────────────────────────

resource "aws_apigatewayv2_stage" "ws" {
  api_id      = aws_apigatewayv2_api.ws.id
  name        = var.stage_name
  auto_deploy = true

  default_route_settings {
    # Deliberately low — the API is unauthenticated and every accepted audio
    # frame triggers paid ASR. This is the main denial-of-wallet guardrail.
    throttling_burst_limit = var.throttling_burst_limit
    throttling_rate_limit  = var.throttling_rate_limit
    data_trace_enabled     = false
    logging_level          = "INFO"
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.ws_access.arn
    format = jsonencode({
      requestId       = "$context.requestId"
      connectionId    = "$context.connectionId"
      routeKey        = "$context.routeKey"
      messageId       = "$context.messageId"
      status          = "$context.status"
      integrationErr  = "$context.integrationErrorMessage"
      responseLatency = "$context.responseLatency"
    })
  }
}

resource "aws_cloudwatch_log_group" "ws_access" {
  name              = "/aws/apigatewayv2/${local.name_prefix}-ws/access"
  retention_in_days = 14
}

# ── Publish outputs to SSM for the async stack ───────────────────────────────

resource "aws_ssm_parameter" "ws_management_url" {
  # The management-API URL used by asr / text-to-gloss to push messages
  # back to a connected client. Note: this is the https:// form, not wss://.
  name  = "${local.ssm_prefix}/api/websocket/management_url"
  type  = "String"
  value = "https://${aws_apigatewayv2_api.ws.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_apigatewayv2_stage.ws.name}"
}

resource "aws_ssm_parameter" "ws_client_url" {
  # The wss:// URL clients (browser extension) connect to.
  name  = "${local.ssm_prefix}/api/websocket/client_url"
  type  = "String"
  value = "wss://${aws_apigatewayv2_api.ws.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_apigatewayv2_stage.ws.name}"
}

resource "aws_ssm_parameter" "ws_api_id" {
  name  = "${local.ssm_prefix}/api/websocket/api_id"
  type  = "String"
  value = aws_apigatewayv2_api.ws.id
}
