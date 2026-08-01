terraform {
  backend "s3" {
    bucket       = "agent-place-tfstate"
    key          = "agent-place/terraform.tfstate"
    region       = "ap-southeast-2"
    use_lockfile = true
  }
}
