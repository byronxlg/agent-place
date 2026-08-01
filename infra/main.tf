data "aws_caller_identity" "current" {}

locals {
  account_id    = data.aws_caller_identity.current.account_id
  function_name = "agent-place"

  lambda_env = merge(
    {
      TABLE_NAME = aws_dynamodb_table.main.name
      NODE_ENV   = "production"
    },
    var.deploy_rev == "" ? {} : { DEPLOY_REV = var.deploy_rev },
  )
}

# --- Terraform state backend (bootstrapped locally once, see CLAUDE.md) ---

resource "aws_s3_bucket" "tfstate" {
  bucket = "agent-place-tfstate"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# --- CI user: scoped Terraform plan/apply for GitHub Actions ---

resource "aws_iam_user" "ci" {
  name = "agent-place-ci"
}

data "aws_iam_policy_document" "ci" {
  statement {
    sid       = "TerraformState"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.tfstate.arn, "${aws_s3_bucket.tfstate.arn}/*"]
  }

  statement {
    sid     = "ManageLambda"
    actions = ["lambda:*"]
    resources = [
      "arn:aws:lambda:${var.region}:${local.account_id}:function:${local.function_name}",
      "arn:aws:lambda:${var.region}:${local.account_id}:function:${local.function_name}:*",
    ]
  }

  statement {
    sid       = "ManageDynamo"
    actions   = ["dynamodb:*"]
    resources = ["arn:aws:dynamodb:${var.region}:${local.account_id}:table/${local.function_name}"]
  }

  # DescribeTimeToLive/ListTagsOfResource run during refresh; keep them with
  # the table grant above. ListTables is not resource-scopable.
  statement {
    sid       = "ListTables"
    actions   = ["dynamodb:ListTables"]
    resources = ["*"]
  }

  statement {
    sid       = "ManageLogs"
    actions   = ["logs:*"]
    resources = ["arn:aws:logs:${var.region}:${local.account_id}:log-group:/aws/lambda/${local.function_name}*"]
  }

  # List-type action; IAM does not support resource-scoping it.
  statement {
    sid       = "DescribeLogGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  # ACM create/list actions are not resource-scopable.
  statement {
    sid       = "ManageCertificates"
    actions   = ["acm:*"]
    resources = ["*"]
  }

  # API Gateway ARNs carry no account id and the v2 API id is generated, so
  # scope by region only.
  statement {
    sid       = "ManageApiGateway"
    actions   = ["apigateway:*"]
    resources = ["arn:aws:apigateway:${var.region}::/*"]
  }

  statement {
    sid     = "ManageOwnIamSurface"
    actions = ["iam:*"]
    resources = [
      aws_iam_user.ci.arn,
      "arn:aws:iam::${local.account_id}:policy/agent-place-ci",
      "arn:aws:iam::${local.account_id}:role/${local.function_name}-lambda",
    ]
  }
}

resource "aws_iam_policy" "ci" {
  name   = "agent-place-ci"
  policy = data.aws_iam_policy_document.ci.json
}

resource "aws_iam_user_policy_attachment" "ci" {
  user       = aws_iam_user.ci.name
  policy_arn = aws_iam_policy.ci.arn
}

# IAM policy changes are eventually consistent; new grants used later in the
# same apply race the propagation. Re-sleeps whenever the policy document
# changes; resources first created under a fresh grant should depend on this
# instead of the policy directly.
resource "time_sleep" "iam_propagation" {
  create_duration = "20s"
  triggers = {
    policy = aws_iam_policy.ci.policy
  }
}

# --- DynamoDB ---

resource "aws_dynamodb_table" "main" {
  name         = local.function_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# --- Lambda ---

resource "aws_iam_role" "lambda" {
  name = "${local.function_name}-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_dynamo" {
  name = "table-access"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
        "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchGetItem",
      ]
      Resource = aws_dynamodb_table.main.arn
    }]
  })
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = 30
}

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../src"
  output_path = "${path.module}/../dist/lambda.zip"
}

resource "aws_lambda_function" "api" {
  function_name    = local.function_name
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  timeout          = 15

  # Cost guardrail: caps concurrent executions (and therefore worst-case spend).
  reserved_concurrent_executions = 10

  environment {
    variables = local.lambda_env
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "public_url" {
  statement_id           = "AllowPublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# --- Custom domain: agent-place.botsmith.dev -> API Gateway -> Lambda ---
# Function URLs cannot serve custom hostnames (they route by Host header),
# so the branded domain goes through an HTTP API. The function URL stays as
# a fallback.

resource "aws_acm_certificate" "api" {
  domain_name       = var.domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  # The CI policy grants acm:* in the same apply that first creates this;
  # order behind the grant plus its propagation delay.
  depends_on = [time_sleep.iam_propagation]
}

resource "cloudflare_dns_record" "acm_validation" {
  for_each = {
    for dvo in aws_acm_certificate.api.domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }

  zone_id = var.cloudflare_zone_id
  name    = trimsuffix(each.value.name, ".")
  type    = each.value.type
  content = trimsuffix(each.value.value, ".")
  ttl     = 60
  proxied = false
}

resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for r in cloudflare_dns_record.acm_validation : r.name]
}

resource "aws_apigatewayv2_api" "api" {
  name          = local.function_name
  protocol_type = "HTTP"

  # Same reasoning as the certificate: the apigateway:* grant ships in this apply.
  depends_on = [time_sleep.iam_propagation]
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

resource "aws_apigatewayv2_domain_name" "api" {
  domain_name = var.domain

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.api.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "api" {
  api_id      = aws_apigatewayv2_api.api.id
  domain_name = aws_apigatewayv2_domain_name.api.id
  stage       = aws_apigatewayv2_stage.default.id
}

resource "cloudflare_dns_record" "api" {
  zone_id = var.cloudflare_zone_id
  name    = var.domain
  type    = "CNAME"
  content = aws_apigatewayv2_domain_name.api.domain_name_configuration[0].target_domain_name
  ttl     = 1
  proxied = false
}
