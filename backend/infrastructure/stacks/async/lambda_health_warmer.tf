resource "aws_cloudwatch_log_group" "health_warmer" {
  name              = "/aws/lambda/${local.name_prefix}-health-warmer"
  retention_in_days = 7
}

resource "aws_lambda_function" "health_warmer" {
  function_name = "${local.name_prefix}-health-warmer"
  role          = aws_iam_role.health_warmer.arn
  package_type  = "Image"
  image_uri     = "${data.aws_ssm_parameter.ecr_health_warmer.value}:${var.image_tag}"

  memory_size   = 128
  timeout       = 30
  architectures = ["x86_64"]

  environment {
    variables = {
      WARM_TARGETS = join(",", [
        aws_lambda_function.asr.function_name,
        aws_lambda_function.text_to_gloss.function_name,
        "${local.name_prefix}-ws-audio-ingest", # created by the api stack
      ])
      LOG_LEVEL = "INFO"
    }
  }

  depends_on = [aws_cloudwatch_log_group.health_warmer]
}

# EventBridge Scheduler: fire the warmer on a rate schedule.
resource "aws_scheduler_schedule" "health_warmer" {
  name = "${local.name_prefix}-warmer"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression = var.warmer_schedule

  target {
    arn      = aws_lambda_function.health_warmer.arn
    role_arn = aws_iam_role.warmer_scheduler.arn
  }
}
