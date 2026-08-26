# Joint Bob public distribution results

## Built

- Renamed public package, PWA, native service, runtime state, release metadata, and installer surfaces to Joint Bob with legacy migration support.
- Added `npx joint-bob install`, verified latest-release downloads, immutable commit/checksum installs, and rollback-safe package replacement.
- Pinned Node.js, Pi, Claude Code, and Syncthing versions. Managed Syncthing now installs and runs as a user service.
- Added Linux and macOS Joint Bob service templates, public project policy files, and tag-driven npm/GitHub release automation.
- Added Terraform under `deploy/aws-ec2-test` and `scripts/ec2-smoke-test.sh` for temporary public-IPv4 EC2 validation.
- Added explicit node-pairing instructions in the application and README.
- Added an exact-commit `main` push deployment hook with mode-0600 SQLite backups and durable installed-copy deployment.
- Audited public text, generated project instructions, service logs, runtime paths, and all PWA icons for Joint Bob branding. Prior identifiers remain only as migration fallbacks.
- Limited WebSocket close reasons to the protocol's 123-byte maximum so agent startup errors cannot crash the service.

## Validation

- TypeScript typecheck and build passed.
- 172 Node tests passed. The monolithic Node runner intermittently stalled after the settings tests, so the remaining files were also run in focused groups.
- Terraform format, validate, and native security test passed.
- Package dry-run contains the Joint Bob CLI and deployment assets.
- Shell and JavaScript syntax checks passed.
- Gitleaks scanned the nine-commit history and current tree with zero findings. GitHub secret scanning reports zero alerts.
- Public package scan found no personal paths, private proxy endpoints, AWS account IDs, test addresses, or private aliases.
- AWS profile `sela` provisioned an encrypted `t3.medium` test instance in `us-west-2` with IMDSv2 required.
- Inbound SSH and HTTPS were restricted to the operator's current IPv4 `/32`.
- Fresh install passed first-run administrator creation, authenticated settings access, service restart, and SQLite preference persistence through the public IPv4 HTTPS endpoint.
- In-place upgrade and legacy `~/.pi-mobile-web` to `~/.joint-bob` migration preserved the administrator and preferences.
- Joint Bob and managed Syncthing user services are active. SQLite quick check passed and the database is mode `0600`.
- Mac and homeserver services now run from `~/.local/share/joint-bob/app`; all existing projects, tasks, users, cluster state, and runtime overrides remain present.

## Runtime state

- The EC2 test environment remains running for manual acceptance.
- Terraform state, the EC2 Instance Connect key, and generated administrator credentials are mode-restricted under `~/.joint-bob-ec2-tests/20260822T194744Z`.
- The public certificate is self-signed and intended only for this temporary smoke test.
- The instance is not paired with the private cluster because pairing credentials must not cross public HTTP or untrusted TLS.
