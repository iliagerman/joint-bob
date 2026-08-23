# Security policy

## Reporting

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository and include affected versions, reproduction steps, and impact.

## Supported version

Only the latest released version receives security fixes.

## Deployment

Joint Bob controls coding agents and stores machine credentials. Run it as a non-root user and expose it only through a private network such as Tailscale. Public-IP deployments are temporary smoke tests, not supported production configurations.
