# TFLint for every stack under platform/infra/ (run: tflint --recursive --config "$PWD/.tflint.hcl").
# The AWS ruleset catches invalid instance/runtime types, deprecated
# arguments and similar mistakes that `terraform validate` accepts.

config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.50.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}
