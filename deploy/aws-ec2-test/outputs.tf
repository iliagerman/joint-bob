output "availability_zone" {
  description = "Availability zone required by EC2 Instance Connect."
  value       = aws_instance.this.availability_zone
}

output "instance_id" {
  description = "Temporary EC2 instance ID."
  value       = aws_instance.this.id
}

output "public_ip" {
  description = "Temporary public IPv4 address."
  value       = aws_instance.this.public_ip
}

output "security_group_id" {
  description = "Security group restricting ingress to the operator /32."
  value       = aws_security_group.this.id
}
