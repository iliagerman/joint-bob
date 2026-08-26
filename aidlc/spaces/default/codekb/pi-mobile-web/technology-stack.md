# Technology stack

## Languages and runtimes

| Technology | Declared or pinned version | Observed use |
|---|---|---|
| Node.js | Engine `>=22.19.0`; managed and CI `22.23.2` | Server runtime, `node:test`, `node:sqlite`, crypto, HTTP, filesystem, subprocesses |
| TypeScript | Manifest `^5.7.2`; locked and installed `5.9.3` | Backend source and all TypeScript tests |
| JavaScript | Native ES modules | Browser PWA, service worker, npm CLI |
| HTML5 | Browser native | Application shell, dialogs, controls, accessibility structure |
| CSS | Browser native | Responsive layout, tokens, themes, animations, safe areas, reduced motion |
| Bash | System shell | Install, deployment, service management, runtime pinning, smoke tests |
| HCL | Terraform `>=1.9,<2.0` | Temporary AWS EC2 smoke infrastructure |

`tsconfig.json` targets ES2022 with `NodeNext` modules and resolution, strict mode, casing enforcement, interoperability, `skipLibCheck`, and `dist/` output.

## Backend frameworks and libraries

| Dependency | Manifest version | Locked/installed version | Role |
|---|---:|---:|---|
| Express | `^4.19.2` | `4.22.2` | REST API, middleware, static serving |
| `ws` | `^8.18.0` | `8.21.3` | WebSocket server, client, and peer proxy |
| Zod | `^3.23.8` | `3.25.76` | HTTP and WebSocket boundary validation |
| `@earendil-works/pi-coding-agent` | `0.84.2` | `0.84.2` | Embedded Pi runtime, SDK, tools, sessions, model inventory |
| `@anthropic-ai/claude-code` | `2.1.239` | `2.1.239` | Bundled Claude CLI |
| `nanoid` | `^5.0.7` | `5.1.16` | Project, task, user, and session identifiers |
| `web-push` | `3.6.7` | `3.6.7` | VAPID and browser push delivery |
| `node:sqlite` | Node built-in | Node runtime | Synchronous SQLite persistence |
| Node crypto | Node built-in | Node runtime | scrypt, timing-safe comparison, AES-256-GCM, hashing, random IDs |

## Frontend platform

The frontend has no framework or bundler. It uses:

- DOM and ES module APIs for state, rendering, events, and dialogs.
- Fetch for REST and WebSocket for chat and watch streams.
- Service Worker, Cache Storage, PushManager, Notifications, and install prompts for PWA behavior.
- History API for mobile panel navigation.
- Web Audio for completion sounds.
- Native CSS media queries, `env(safe-area-inset-*)`, colour tokens, dark/light themes, and `prefers-reduced-motion`.

`public/sw.js` uses cache `joint-bob-v25`. Every path in `APP_SHELL` existed during the scan.

## Agent and model runtime

Pi model availability comes from `ModelRuntime`. The current preference order checks configured `JOINT_BOB_MODEL` or legacy `PI_MOBILE_WEB_MODEL`, then GPT-5.6 Sol, Terra, Luna, Gemini 3.1 Pro preview, Gemini 2.5 Pro, and remaining non-deprecated models. The browser filters the displayed Pi list to `openai-codex` and `zai` providers. The active Pi session exposes available thinking levels through the SDK.

Claude execution spawns `claude -p --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions`. Optional `--resume`, `--model`, and `--effort` arguments come from the session or task configuration. The browser currently offers Fable, Opus 5, Sonnet, Haiku 4.5 and effort values through `max`.

## Build and test tooling

| Tool | Version or configuration | Role |
|---|---|---|
| npm | Lockfile version 3 | Dependency install, scripts, package publication |
| TypeScript compiler | Locked `5.9.3` | Build and typecheck |
| `tsx` | Manifest `^4.19.2`; locked `4.23.12` | Development watch and TypeScript test loader |
| `node:test` | Node built-in | Main test framework |
| `node:assert/strict` | Node built-in | Assertions |
| Terraform native tests | Terraform `>=1.9,<2.0` | AWS security configuration tests |
| Just | External command runner | Installed-node update commands |

No linter, formatter, coverage reporter, browser E2E framework, or frontend typechecker is configured.

## Infrastructure and delivery stack

| Technology | Version or pin | Use |
|---|---|---|
| Syncthing | `2.1.3` | Project, ticket workspace, and selected engine-data synchronization |
| Terraform | `>=1.9,<2.0` | EC2 smoke environment |
| AWS provider | `~>6.0` | EC2, network, and storage resources |
| GitHub Actions | `checkout@v4`, `setup-node@v4`, `softprops/action-gh-release@v2` | Tag release pipeline |
| systemd | Host native | Linux user service |
| launchd | Host native | macOS launch agent |
| Tailscale Serve | Host external | Private HTTPS access |
| Git | Host external | Worktrees, bundles, release packaging, deployment commit selection |

## Version and audit notes

The direct lock contains 279 transitive package entries. `package-lock.json` and `npm-shrinkwrap.json` are byte-identical. The configured npm registry returned HTTP 400 when dependency audit was attempted, so vulnerability status is unverified.
