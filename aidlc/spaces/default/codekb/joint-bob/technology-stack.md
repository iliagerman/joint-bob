# Technology Stack — Joint Bob

Versions below are exactly as declared in `package.json` and as resolved in the lockfiles at commit
`c3e9b0508fba185dbc4ab8bb7ad5fa6debadd5fa`.

## Languages and runtime

| Layer | Language | Notes |
|---|---|---|
| Server | **TypeScript** | `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`, `strict: true`, `esModuleInterop: true`, `forceConsistentCasingInFileNames: true`, `skipLibCheck: true`, `outDir: dist`, `include: ["src/**/*.ts"]` |
| Client | **Vanilla JavaScript** | No framework, no bundler, no transpile. `public/` is served verbatim. **Not covered by `tsconfig`.** |
| Scripts | **Bash** and **Node ESM (`.mjs`)** | 17 files under `scripts/`, plus `bin/joint-bob.mjs` |
| Infrastructure | **HCL (Terraform)** | `deploy/aws-ec2-test/` |

**Runtime:** Node.js, `engines.node: ">=22.19.0"`. This floor is **not negotiable** — the entire
persistence layer is Node's built-in `node:sqlite`, which is Node 22+ only. The installer pins
Node **22.23.2** (`scripts/versions.sh`) and CI uses the same.

**Module system:** `"type": "module"` — ESM throughout, with `.js` extensions on relative imports.

## Package metadata

| Field | Value |
|---|---|
| `name` | `joint-bob` |
| `version` | `0.2.0` |
| `description` | "Private multi-node workspace for Pi and Claude coding agents" |
| `private` | `false` — published to npm with `--provenance --access public` |
| `license` | MIT |
| `bin` | `joint-bob` → `bin/joint-bob.mjs` |
| `repository` | `git+https://github.com/iliagerman/joint-bob.git` |
| `files` | `bin`, `deploy`, `public`, `scripts`, `src`, `CHANGELOG.md`, `LICENSE`, `README.md`, `SECURITY.md`, `.joint-bob-release`, `npm-shrinkwrap.json`, `tsconfig.json` |

## Runtime dependencies — declared versus lockfile-resolved

| Package | Declared in `package.json` | Resolved in lockfile | Purpose |
|---|---|---|---|
| `@anthropic-ai/claude-code` | `2.1.239` (exact) | **2.1.239** | Claude Code agent, embedded as a library |
| `@earendil-works/pi-coding-agent` | `0.84.2` (exact) | **0.84.2** | Pi agent — `SessionManager`, `AgentSession`, `AgentSessionEvent` |
| `express` | `^4.19.2` | **4.22.2** | HTTP server |
| `ws` | `^8.18.0` | **8.21.3** | WebSocket server |
| `zod` | `^3.23.8` | **3.25.76** | Request and replication-event validation at every boundary |
| `node-pty` | `^1.2.0-beta.15` | **1.2.0-beta.15** | Real PTY for the embedded terminal — **beta, native build** |
| `nanoid` | `^5.0.7` | **5.1.16** | Project IDs — `nanoid(10)` at `store.ts:490` |
| `web-push` | `^3.6.7` | **3.6.7** | VAPID browser push notifications |
| `codemirror` | `5.65.16` (exact) | **5.65.16** | File editor — **CodeMirror 5, an end-of-life line** |

**Nine runtime dependencies total.** Two are pinned exactly because they *are* the product (the two
agents); one is pinned exactly because it is vendored to the browser (CodeMirror).

## Dev dependencies

| Package | Declared | Resolved |
|---|---|---|
| `typescript` | `^5.7.2` | **5.9.3** |
| `tsx` | `^4.19.2` | **4.23.12** |
| `@types/node` | `^22.10.2` | **22.20.1** |
| `@types/express` | `^4.17.21` | (declared only) |
| `@types/ws` | `^8.5.13` | (declared only) |
| `@types/web-push` | `^3.6.4` | (declared only) |

**There is no linter, formatter, test framework, coverage tool, or bundler in devDependencies.**

## Node built-ins carrying architectural weight

No external library is used for any of these. This is a deliberate and unusually strong stance.

| Built-in | What it replaces | Where |
|---|---|---|
| **`node:sqlite`** (`DatabaseSync`, `SQLInputValue`) | An ORM, a query builder, and a database server | The entire persistence layer, 49 tables. Node 22+ only — this is what forces the engines floor. |
| **`node:crypto`** | A crypto library or KMS | `createCipheriv` / `createDecipheriv` with **AES-256-GCM**, `randomBytes`, `randomUUID`, `createHash` (SHA-256 for legacy-file digests). Every secret at rest. |
| **`node:test` + `node:assert/strict`** | Jest, Vitest, Mocha, Playwright, Testing Library | The entire 140-file test suite |
| `node:child_process` | — | `execFile` for every `git` invocation; `spawnSync` in the installer |
| `node:fs`, `node:fs/promises`, `node:os`, `node:path`, `node:url` | — | Data dir resolution, secret files, transcripts |

## Build and scripts

| Script | Command |
|---|---|
| `build` | `tsc` |
| `dev` | `tsx watch src/server.ts` |
| `start` | `npm run build && node dist/server.js` |
| `test` | `node --import tsx --test --test-concurrency=4 test/*.test.ts` |
| `typecheck` | `tsc --noEmit` |
| `serve:https` | `bash scripts/serve-https.sh` |
| `prepack` | `npm run build` |

**There is no build step for the client at all.** `just` is deploy-only (`update-local`,
`update-homeserver`, `update`), not a build tool — each recipe calls
`./scripts/deploy-installed-nodes.sh "$(git rev-parse HEAD)" <target>`.

Verification run during the scan: `npx tsc --noEmit` → **exit 0, no diagnostics.**

## External binaries pinned and managed by the application

Declared in `scripts/versions.sh`:

| Binary | Pinned version | Notes |
|---|---|---|
| Node.js | `JOINT_BOB_NODE_VERSION=22.23.2` | installed by `scripts/install-node-runtime.sh` |
| Pi | `JOINT_BOB_PI_VERSION=0.84.2` | matches the npm dependency |
| Claude Code | `JOINT_BOB_CLAUDE_VERSION=2.1.239` | matches the npm dependency |
| Syncthing | `JOINT_BOB_SYNCTHING_VERSION=2.1.3` | plus four per-platform SHA-256 checksums: `linux-amd64`, `linux-arm64`, `macos-amd64`, `macos-arm64` |

Also required at runtime but not installed by the app: **`git`** and **`gh`** (both authenticated
purely via injected environment variables), and **Tailscale** (optional, for private HTTPS via
`tailscale serve`).

## Client technology

**Zero frameworks.** Plain DOM APIs — `document.querySelector`, `document.createElement`,
`element.replaceChildren()` — native `<dialog>` elements with `showModal()` / `close()`, and
`data-testid` attributes throughout.

**PWA.** Service worker at `public/sw.js`; `public/manifest.webmanifest`. `AGENTS.md` mandates that
`CACHE_NAME` be bumped whenever the shell or icons change.

**The only vendored asset** is xterm.js under `public/vendor/xterm/` — `xterm.js` and
`addon-fit.js` (each minified to one line) plus `xterm.css` (285 lines).

**CodeMirror 5** is served from `node_modules` through
`app.use("/vendor/codemirror", express.static(codemirrorDir, { index: false }))` at
`server.ts:790`.

**CSP constrains the client's options** (`server.ts:487`):
`default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'`
— no inline script, no external origin. This is why provider brand icons are drawn inline as
markup rather than fetched (`app.js:5681`: *"Brand marks, drawn inline so the offline shell never
reaches for a network icon."*).

## Persistence and storage

| Item | Technology | Location |
|---|---|---|
| Application state | SQLite via `node:sqlite`, WAL mode, `foreign_keys = ON` | `~/.joint-bob/node.db`, 49 tables |
| Encryption key | 32 raw bytes, base64-encoded, mode `0600` | `~/.joint-bob/secret.key`, overridable via `JOINT_BOB_SECRET_KEY` or `MASTER_BOB_SECRET_KEY` |
| Secret file material | Plain files, mode `0600` in a `0700` directory | `~/.joint-bob/secret-files/<accountId>/<VAR_NAME>` |
| Generated git credential helper | Shell script, mode `0700` | `~/.joint-bob/github-askpass.sh` |
| Node-local env overrides | Plain file | `~/.joint-bob/env` |
| Deploy logs | Plain file | `~/.joint-bob/logs/push-deploy.log` |
| Project file content between nodes | Syncthing 2.1.3 | project directories |

Data dir resolution, identical in 17 modules:
`process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob")`.

**No external database, no cache, no message broker, no object store.**

## CI/CD and infrastructure

| Item | Technology | Version / detail |
|---|---|---|
| CI | GitHub Actions | one workflow, `.github/workflows/release.yml`, triggered **only on `v*` tag push** |
| Release | `softprops/action-gh-release@v2` + `npm publish --provenance --access public` | permissions `contents: write`, `id-token: write` |
| Service management | systemd user unit (`joint-bob.service`, requires `loginctl enable-linger`) and macOS launch agent (`com.joint-bob.node`) | `deploy/` |
| Smoke-test infrastructure | Terraform | `>= 1.9, < 2.0`; AWS provider `~> 6.0`; region from `var.aws_region` |
| Local gate | git `pre-push` hook, per-clone and opt-in | `scripts/hooks/pre-push`, installed by `scripts/install-git-hooks.sh` |
| Changelog automation | Claude (Haiku) invoked from `scripts/changelog-gate.mjs` | writes `package.json` version + `CHANGELOG.md`, then **refuses the push** so the human commits them |

## Lockfiles

- `npm-shrinkwrap.json` — 138,169 bytes; **this is what ships in the published tarball**
- `package-lock.json` — 138,169 bytes; a **byte-identical duplicate** that must be kept in lockstep
  by hand

## Version-related risks

1. **`node-pty@1.2.0-beta.15`** — a beta native module pinned in production, required by the
   embedded terminal. Native rebuild is a real risk across the Node 22.23.2 pin and two supported
   platforms (macOS and Linux, x64 and arm64).
2. **`codemirror@5.65.16`** — CodeMirror 5 is end-of-life; CM6 is the maintained line.
3. **The two agent packages are pinned exactly in three places** — `package.json`, the lockfiles,
   and `scripts/versions.sh`. All three must move together.
4. **`engines.node: ">=22.19.0"` cannot be relaxed** without replacing `node:sqlite`.
