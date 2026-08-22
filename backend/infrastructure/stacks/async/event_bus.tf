# ── EventBridge: signstream-bus + rule → text-to-gloss ────────────────────────
#
# asr publishes signstream.transcript events onto this bus.
# text-to-gloss subscribes via a rule that matches detail-type.
# sign-id events are also published here for downstream analytics observers.

resource "aws_cloudwatch_event_bus" "signstream" {
  name = "${local.name_prefix}-bus"
}

resource "aws_cloudwatch_event_rule" "transcript" {
  name           = "${local.name_prefix}-transcript-rule"
  description    = "Route signstream.transcript events to text-to-gloss."
  event_bus_name = aws_cloudwatch_event_bus.signstream.name

  event_pattern = jsonencode({
    "detail-type" = ["signstream.transcript"]
    source        = ["signstream.asr"]
  })
}

# The target is defined next to the Lambda in lambda_text_to_gloss.tf

resource "aws_ssm_parameter" "event_bus_name" {
  name  = "${local.ssm_prefix}/async/event_bus/name"
  type  = "String"
  value = aws_cloudwatch_event_bus.signstream.name
}

resource "aws_ssm_parameter" "event_bus_arn" {
  name  = "${local.ssm_prefix}/async/event_bus/arn"
  type  = "String"
  value = aws_cloudwatch_event_bus.signstream.arn
}
