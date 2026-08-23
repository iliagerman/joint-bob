variable "aws_region" {
  description = "AWS region for the temporary smoke-test instance."
  type        = string
  default     = "us-west-2"
  nullable    = false
}

variable "allowed_cidr" {
  description = "Single operator IPv4 /32 allowed to reach SSH and Joint Bob."
  type        = string

  validation {
    condition     = can(cidrhost(var.allowed_cidr, 0)) && split("/", var.allowed_cidr)[1] == "32" && var.allowed_cidr != "0.0.0.0/0"
    error_message = "allowed_cidr must be one IPv4 /32 address."
  }

  nullable = false
}

variable "instance_type" {
  description = "EC2 instance type used for the temporary build and smoke test."
  type        = string
  default     = "t3.medium"
  nullable    = false
}

variable "name" {
  description = "Name and ownership tag prefix for temporary resources."
  type        = string
  default     = "joint-bob-ec2-test"
  nullable    = false
}
