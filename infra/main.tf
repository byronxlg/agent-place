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
