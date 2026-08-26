# Joint Bob public distribution code generation plan

1. Add failing distribution, branding, version-pin, migration, and package smoke tests.
2. Add the central pinned-version manifest and managed Syncthing installer/service assets.
3. Rework prerequisite validation so bundled executables are used and authentication is reported without blocking startup.
4. Rename package, PWA, service, runtime, cookie, release, and environment surfaces with compatibility fallbacks for migration.
5. Add atomic state/service migration from the prior installation names.
6. Add the npm CLI and package allowlist, then validate `npm pack` contents and execution.
7. Add latest-release checksum bootstrap while preserving explicit immutable installation.
8. Add MIT, security, contribution, code-of-conduct, and public installation documentation.
9. Add tag-driven GitHub Release and npm trusted-publishing workflow.
10. Run focused tests, full tests, typecheck, build, shell syntax, package dry-run, secret/personal-value scan, and fresh-install smoke tests.
11. Add isolated Terraform and an EC2 smoke-test runner with `/32` ingress, EC2 Instance Connect, unpublished-source installation, authenticated persistence checks, and explicit teardown.
12. Document private node pairing and why public HTTP is smoke-test-only.
13. Provision with AWS profile `sela`, test through the public IPv4 address, retain or destroy the instance according to the test-run option, and record resource IDs.
14. Audit every public/runtime/icon surface and confine prior names to migration compatibility.
15. Add a versioned pre-push hook that waits for remote `main` confirmation and deploys the exact pushed commit to durable Mac and homeserver installations.
16. Migrate the current Mac and homeserver away from source-checkout services after mode-0600 SQLite backups, then verify projects, settings, credentials, cluster identity, and runtime overrides.
17. Scan the complete Git history and clean publication tree before repository publication. Use no force push to `main`.
18. Do not publish, rename the GitHub repository, commit, or push without explicit approval.
