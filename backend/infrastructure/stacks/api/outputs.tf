output "websocket_client_url" {
  description = "wss:// URL clients connect to. Set as WS_ENDPOINT in extension/src/shared/config.ts."
  value       = "wss://${aws_apigatewayv2_api.ws.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_apigatewayv2_stage.ws.name}"
}

output "websocket_management_url" {
  description = "https:// URL asr / text-to-gloss use to push messages back to clients."
  value       = "https://${aws_apigatewayv2_api.ws.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_apigatewayv2_stage.ws.name}"
}

output "websocket_api_id" {
  value = aws_apigatewayv2_api.ws.id
}

output "ws_connect_lambda_arn" {
  value = aws_lambda_function.ws_connect.arn
}

output "ws_disconnect_lambda_arn" {
  value = aws_lambda_function.ws_disconnect.arn
}

output "ws_audio_ingest_lambda_arn" {
  value = aws_lambda_function.ws_audio_ingest.arn
}
