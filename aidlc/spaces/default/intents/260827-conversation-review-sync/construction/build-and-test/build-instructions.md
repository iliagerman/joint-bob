# Build Instructions

## Inputs and environment

These instructions validate the implementation described by `construction/code-generation/code-generation-plan.md`, `unit-test-instructions.md`, and `code-summary.md`.

Requirements:

- Node.js 22.19 or newer.
- Repository dependencies installed from `npm-shrinkwrap.json` with `npm ci` when starting from a clean checkout.
- No external agent model calls. Process tests use local stubs.
- Syncthing operational checks require the existing local Joint Bob/Syncthing configuration.

## Build and verification commands

Run from the repository root:

```bash
npm run typecheck
npm test
npm run build
```

Expected result: all commands exit 0; TypeScript emits `dist/`; the complete Node test suite reports no failures.

For dependency security metadata, use the public registry because the configured private npm proxy does not implement the audit endpoint correctly:

```bash
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
```

Expected result: exit 0 and no high-or-greater production dependency vulnerability.

## Troubleshooting

- `ExperimentalWarning: SQLite` is expected under Node 22 and is not a test failure.
- If a process-isolated test hangs, confirm ports and temporary child processes from an interrupted prior run are gone, then rerun the exact focused file command.
- A private-registry `400 Bad Request` from `npm audit` is an endpoint limitation; retry the same lockfile against the public npm audit endpoint as shown above.
- Do not run production from the source checkout. Installed services remain under `~/.local/share/joint-bob/app`.
