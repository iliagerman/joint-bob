mock_provider "aws" {
  mock_data "aws_ssm_parameter" {
    defaults = {
      value = "ami-0123456789abcdef0"
    }
  }
}

variables {
  allowed_cidr = "203.0.113.10/32"
}

run "secure_plan" {
  command = plan

  assert {
    condition     = aws_instance.this.metadata_options[0].http_tokens == "required"
    error_message = "EC2 must require IMDSv2."
  }

  assert {
    condition     = aws_instance.this.root_block_device[0].encrypted
    error_message = "Root storage must be encrypted."
  }

  assert {
    condition     = alltrue([for rule in aws_security_group.this.ingress : length(rule.cidr_blocks) == 1 && contains(rule.cidr_blocks, "203.0.113.10/32")])
    error_message = "Every inbound rule must use the operator /32."
  }
}
