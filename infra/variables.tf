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

variable "domain" {
  type    = string
  default = "agent-place.botsmith.dev"
}

# botsmith.dev
variable "cloudflare_zone_id" {
  type    = string
  default = "48ca6d98636690b501989633f07852a1"
}
