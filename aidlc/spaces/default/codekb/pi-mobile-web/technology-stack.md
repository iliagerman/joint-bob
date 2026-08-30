# Technology Stack

## Languages and Runtime

| Layer | Language | Notes |
|---|---|---|
| Server | TypeScript | `strict: true`, `target: ES2022`, `module` and `moduleResolution` both `NodeNext`, `"type": "module"`, `outDir: dist`, `include: ["src/**/*.ts"]` |
| Client | Vanilla JavaScript | Native browser ES modules, no transpilation, no bundling |
| Install and deploy | Bash | 14 shell scripts under `scripts/` |
| Installer CLI | JavaScript (`.mjs`) | `bin/joint-bob.mjs` |
| Infrastructure | HCL (Terraform) | `deploy/aws-ec2-test/` only |

**Node.js**: `engines` declares `>=22.19.0`. CI and the installer both pin **22.23.2** via `scripts/versions.sh`, which also pins the engine package versions.

## Runtime Dependencies

Declared range → version resolved in `npm-shrinkwrap.json` (the shrinkwrap is what ships in the published tarball; `package-lock.json` is also present).

| Package | Declared | Resolved | Purpose |
|---|---|---|---|
| `express` | `^4.19.2` | **4.22.2** | HTTP server and routing |
| `ws` | `^8.18.0` | **8.21.3** | WebSocket server for `/ws` |
| `zod` | `^3.23.8` | **3.25.76** | Request body validation on every route |
| `nanoid` | `^5.0.7` | **5.1.16** | Id generation |
| `web-push` | `^3.6.7` | **3.6.7** | Web push delivery |
| `@anthropic-ai/claude-code` | pinned | **2.1.239** | The `claude` CLI, spawned as a subprocess |
| `@earendil-works/pi-coding-agent` | pinned | **0.84.2** | Pi agent SDK, used in-process |

Both engine packages are **exact-pinned**, not ranged — an agent runtime's behaviour is part of the product's contract, so a patch bump is a deliberate change rather than an install-time surprise.

## Development Dependencies

| Package | Declared | Resolved | Purpose |
|---|---|---|---|
| `typescript` | `^5.7.2` | **5.9.3** | `tsc` — the only enforced quality gate |
| `tsx` | `^4.19.2` | **4.23.12** | `dev` watch mode and the test loader |
| `@types/node` | 22.x | | Node type definitions |
| `@types/express` | 4.17.x | | Express type definitions |
| `@types/ws` | 8.5.x | | `ws` type definitions |
| `@types/web-push` | 3.6.x | | `web-push` type definitions |

There is **no** linter, formatter, bundler, test framework, coverage tool, ORM or migration tool in the dependency tree. That absence is a deliberate stack choice, not an oversight — see *Platform Choices* below.

## Build and Task Tooling

| Script | Command | Purpose |
|---|---|---|
| `build` | `tsc` | Compiles `src/` to `dist/` |
| `dev` | `tsx watch src/server.ts` | Development server |
| `test` | `node --import tsx --test test/*.test.ts` | Full suite via Node's built-in runner |
| `typecheck` | `tsc --noEmit` | Type gate |
| `start` | build + `node dist/server.js` | Production start |
| `prepack` | `build` | Ensures `dist/` is present in the tarball |
| `serve:https` | `scripts/serve-https.sh` | Local HTTPS for PWA testing |

A `Justfile` wraps the common combinations. `AGENTS.md` mandates running `typecheck`, `test` and `build` before delivering a change.

## Data and Cryptography

| Concern | Choice | Detail |
|---|---|---|
| Datastore | **`node:sqlite`** (`DatabaseSync`) | The only datastore. Single file at `~/.joint-bob/node.db`, `journal_mode = WAL`, `busy_timeout = 5000` |
| ORM / query builder | **none** | Raw SQL; rows come back untyped and are bridged with 99 `as unknown as` casts |
| Migrations | **none** | `CREATE TABLE IF NOT EXISTS` at module load plus hand-written `ALTER TABLE … RENAME TO …_old` / re-insert / `DROP` sequences — `ensureConversationOwnershipSchema` is the worked example |
| Password hashing | `node:crypto` scrypt | |
| Secret and token encryption | `node:crypto` AES | Secrets, machine tokens, GitHub credentials, push keys |
| Token comparison | `node:crypto` `timingSafeEqual` | Machine token verification |
| Filesystem permissions | `0o700` state directory, `0o600` files | |

Choosing `node:sqlite` — the runtime's own built-in, added in Node 22 — is what lets the whole server ship with seven runtime dependencies and no native module to compile on a Raspberry Pi.

## Client Stack

Zero frameworks and zero build step. Specifically:

- Native browser **ES modules**, loaded directly by `<script type="module">`.
- Native **`<dialog>`** elements for the transfer, ownership and settings flows.
- A hand-rolled, **XSS-safe Markdown renderer** (`public/markdown.js`) rather than a Markdown library.
- A **service worker** (`public/sw.js`) with a manually versioned `CACHE_NAME`, currently `joint-bob-v52`.
- `public/styles.css` — 1,585 hand-written lines; no preprocessor, no utility framework.

## External System Dependencies

These are not npm packages; the product does not run without them.

| System | Role | Interface |
|---|---|---|
| **Tailscale** | The private network peers reach each other over | transparent — the app just uses peer hostnames |
| **Syncthing** | Replicates `~/.claude` (`dot-claude` folder, `src/syncthing.ts:41`) and project directories between nodes | REST `/rest/...` with `X-API-Key` |
| **`claude` CLI** | Claude engine | subprocess, `stream-json` on stdout |
| **Pi agent SDK** | Pi engine | in-process |
| **`git`** | Worktree and bundle handoff | `execFile`, no shell |
| **User `$SHELL`** | Terminal channel | spawned pty |

## Infrastructure and Distribution

| Concern | Choice |
|---|---|
| Packaging | npm package `joint-bob` with a `joint-bob` bin; `npm publish --provenance` |
| Install | `bin/joint-bob.mjs install` — staged copy, atomic rename, rollback — driven by `scripts/install.sh` / `scripts/install-service.sh` |
| Service management | systemd user unit (`deploy/joint-bob.service`), macOS launch agent (`deploy/com.joint-bob.node.plist`) |
| CI | GitHub Actions, one workflow (`.github/workflows/release.yml`), triggered **only** on `v*` tags |
| Infrastructure as code | Terraform, AWS provider **6.61.0** (lockfile pinned), scoped to the EC2 smoke-test harness in `deploy/aws-ec2-test/` |
| Infrastructure tests | `terraform test` against `deploy/aws-ec2-test/tests/security.tftest.hcl` |
| Licence | MIT |

## Platform Choices Worth Naming

Three stack decisions shape everything downstream:

1. **`node:sqlite` instead of any database dependency.** Zero install friction, zero native compilation, one file to back up. The cost is untyped rows, no migration framework and no schema owner.
2. **No client build step.** Install is a file copy that works identically on a Pi and a laptop. The cost is a 4,776-line `public/app.js` with no module boundaries and a manually versioned service-worker cache.
3. **`tsc --strict` as the sole enforced gate.** No linter, no formatter, no coverage threshold. The codebase carries zero `@ts-ignore`, `@ts-expect-error` or `eslint-disable` directives in `src/` or `public/`, so the gate is genuinely clean — but it is also the only automated check that a change must pass, and it is not run on push or on a pull request.
