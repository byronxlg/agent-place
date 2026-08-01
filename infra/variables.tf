variable "region" {
  type    = string
  default = "ap-southeast-2"
}

# CI stamps the run id so each deploy updates the function config and
# recycles warm instances.
variable "deploy_rev" {
  type    = string
  default = ""
}
