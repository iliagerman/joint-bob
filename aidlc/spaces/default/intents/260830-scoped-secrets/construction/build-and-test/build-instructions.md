# Build Instructions — Scoped Secrets

Derived from `<record>/construction/code-generation/code-generation-plan.md` and
`code-summary.md`. This is a brownfield repository: the toolchain already exists, so these
instructions verify it rather than bootstrap it.

## Prerequisites

- Node.js 22 or newer (verified on v22.23.2). The project uses `node:sqlite`, which is
  experimental and prints a warning on every run — that warning is expected, not a failure.
- npm 10 or newer (verified on 10.9.8).
- No database server, container, or cloud credential is required. All tests build their own
  SQLite database in a temporary directory.

## Dependency installation

```bash
npm ci
```

Use `npm ci` rather than `npm install` so the lockfile is authoritative.

## Build

```bash
npm run build
```

This is `tsc` against `tsconfig.json`. It emits to `dist/` and is the same compiler
invocation the release workflow runs.

## Build verification

```bash
npx tsc --noEmit
```

Exit code 0 with no output means the tree type-checks. This is the load-bearing static check
for this change, because `public/` is plain JavaScript and is not type-checked at all.

## Environment

No environment variable is required to build or test. Two are relevant at runtime and one is
used by the new tests:

- `JOINT_BOB_DATA_DIR` / `PI_WEB_DATA_DIR` — where the node's SQLite database and secret key
  live. Tests point this at a temporary directory.
- `JOINT_BOB_SECRET_KEY` / `MASTER_BOB_SECRET_KEY` — a base64 32-byte key that overrides the
  on-disk `secret.key`. Two new test files set it so fixtures and the module instance agree
  on one key.

## Troubleshooting

- **`npm audit` fails with `unexpected end of file`.** This repository resolves packages
  through a private registry at `100.83.230.57:4873` that does not implement the npm audit
  endpoint. It is an environment limitation, not a build failure; dependency scanning has to
  run against the public registry or a separate SCA tool.
- **SQLite experimental warning.** `node:sqlite` prints `ExperimentalWarning` on every run.
  Expected.
- **A test hangs or reuses stale data.** Backend tests import modules with a cache-busting
  query string so each file gets a fresh database handle. If a test misbehaves after an edit,
  check that its import still carries the unique suffix.
