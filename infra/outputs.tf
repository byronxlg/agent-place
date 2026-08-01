output "function_url" {
  value = aws_lambda_function_url.api.function_url
}

output "domain" {
  value = "https://${var.domain}"
}
