data "aws_ssm_parameter" "ubuntu_ami" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

resource "aws_vpc" "this" {
  cidr_block           = "10.99.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name      = var.name
    ManagedBy = "terraform"
    Purpose   = "temporary-smoke-test"
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name      = var.name
    ManagedBy = "terraform"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = "10.99.1.0/24"
  map_public_ip_on_launch = true

  tags = {
    Name      = "${var.name}-public"
    ManagedBy = "terraform"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = {
    Name      = "${var.name}-public"
    ManagedBy = "terraform"
  }
}

resource "aws_route_table_association" "public" {
  route_table_id = aws_route_table.public.id
  subnet_id      = aws_subnet.public.id
}

resource "aws_security_group" "this" {
  name_prefix = "${var.name}-"
  description = "Joint Bob temporary smoke test"
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "EC2 Instance Connect SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  ingress {
    description = "Joint Bob HTTPS smoke test"
    from_port   = 8443
    to_port     = 8443
    protocol    = "tcp"
    cidr_blocks = [var.allowed_cidr]
  }

  egress {
    description = "Package and release downloads"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name      = var.name
    ManagedBy = "terraform"
  }
}

resource "aws_instance" "this" {
  ami                         = data.aws_ssm_parameter.ubuntu_ami.value
  associate_public_ip_address = true
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.this.id]
  user_data_replace_on_change = true

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    encrypted   = true
    volume_size = 24
    volume_type = "gp3"
  }

  user_data = <<-CLOUD_INIT
    #cloud-config
    package_update: true
    packages:
      - ca-certificates
      - curl
      - nginx
      - openssl
    runcmd:
      - [loginctl, enable-linger, ubuntu]
  CLOUD_INIT

  tags = {
    Name      = var.name
    ManagedBy = "terraform"
    Purpose   = "temporary-smoke-test"
  }

  depends_on = [aws_route_table_association.public]
}
