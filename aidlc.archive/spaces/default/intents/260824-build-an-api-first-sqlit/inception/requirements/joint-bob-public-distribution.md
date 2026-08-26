# Joint Bob public distribution requirements

## Intent

Rename Master Bob to Joint Bob and make a fresh macOS or Linux node installable through one command or `npx`, with pinned prerequisites and rollback-safe upgrades.

## Requirements

1. Public product, package, service, PWA, installer, runtime directory, and environment names use Joint Bob.
2. Existing `~/.pi-mobile-web`, `pi-mobile-web.service`, and `com.master-bob.node` installations migrate without losing SQLite state, credentials, projects, tasks, settings, or cluster identity.
3. Legacy names remain only where required to migrate an existing installation or read an existing configuration.
4. `joint-bob` is a public npm package with a `joint-bob` executable and exact runtime dependency versions.
5. A fresh user can install with either `curl .../install.sh | bash` or `npx joint-bob install`.
6. The default bootstrap downloads the latest GitHub Release archive and SHA-256 file. Explicit immutable commit and checksum installation remains supported.
7. The installer pins Node.js 22.23.2, Pi 0.84.2, Claude Code 2.1.239, and Syncthing 2.1.3 from one version manifest.
8. Pi and Claude executables come from the installed package. Authentication is checked but incomplete authentication does not prevent Joint Bob from starting.
9. Syncthing is downloaded from its official release, checksum-verified, and started as a user service when no usable Syncthing daemon exists.
10. Tailscale remains optional. The installer may guide installation but never exposes Joint Bob publicly or enables Funnel.
11. Linux and macOS on x64 and arm64 are supported.
12. Release automation runs tests, packs and smoke-tests the npm package, publishes npm provenance, and creates checksum-bearing GitHub Release artifacts from version tags.
13. Public repository files include MIT licensing, contribution instructions, security policy, and installation/upgrade/uninstall documentation.
14. No package, installer, service template, documentation, or workflow contains personal paths, private registry URLs, tokens, internal aliases, or private service endpoints.
15. Publishing, repository renaming, commits, and pushes remain manual actions until explicitly requested.
16. A repeatable EC2 smoke-test environment must provision in `us-west-2` with AWS profile `sela`, a public IPv4 address, encrypted storage, IMDSv2, and inbound access restricted to the operator's current `/32` address.
17. The EC2 smoke test must install an unpublished local build without requiring a GitHub release or npm publication, verify first-run setup, authenticated API access, service restart, and SQLite persistence, and provide an explicit destroy command.
18. Public-IP testing must not send pairing credentials over plain HTTP. Cluster pairing remains a private-network operation.
19. Node onboarding documentation must explain the two-sided pairing flow: configure the new node, copy its pairing token, then add its URL and token from an existing node.
20. Public product text, icons, generated project instructions, runtime paths, service logs, and new environment names use Joint Bob. Prior names remain only as explicit migration inputs.
21. Production services on the Mac and homeserver run from `~/.local/share/joint-bob/app`, not from either source checkout.
22. A versioned Git pre-push hook must detect successful pushes to `main`, then deploy the exact pushed commit to durable installed copies on the Mac and homeserver.
23. README starts with a terse setup TL;DR and documents installation, adding nodes, automatic deployment, service operation, migration, EC2 testing, and teardown.
24. Before public publication, the current tree and complete Git history must be scanned for credentials and private machine values. History replacement requires a non-force-push publication path or explicit manual owner action.
