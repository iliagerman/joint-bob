# Technology Stack

## Languages and Runtimes

| Technology | Version | Use |
|---|---|---|
| Node.js | Required `>=22.19.0`; pinned/observed `22.23.2` | Server, `node:test`, `node:sqlite`, crypto, HTTP, filesystem, subprocesses |
| TypeScript | Declared `^5.7.2`; resolved `5.9.3` | Strict backend source and tests |
| JavaScript | Native ES modules | Browser PWA, service worker, CLI |
| HTML/CSS | Browser native | UI shell, components, responsive and accessible presentation |
| Bash | Host shell | Installation, services, deployment, smoke testing |
| HCL | Terraform `>=1.9,<2.0` | Temporary AWS EC2 smoke infrastructure |

`tsconfig.json` uses ES2022, NodeNext modules/resolution, strict checking, casing enforcement, `esModuleInterop`, `skipLibCheck`, and `dist/` output.

## Application Libraries

| Dependency | Declared | Resolved | Role |
|---|---:|---:|---|
| Express | `^4.19.2` | `4.22.2` | HTTP API, middleware, static PWA |
| `ws` | `^8.18.0` | `8.21.3` | Browser/peer WebSockets |
| Zod | `^3.23.8` | `3.25.76` | HTTP and socket input validation |
| `@earendil-works/pi-coding-agent` | `0.84.2` | `0.84.2` | Embedded Pi sessions, tools, models, events |
| `@anthropic-ai/claude-code` | `2.1.239` | `2.1.239` | Installed Claude CLI runtime |
| `nanoid` | `^5.0.7` | `5.1.16` | Application identifiers |
| `web-push` | `3.6.7` | `3.6.7` | VAPID push notifications |
| `node:sqlite` | Node built-in | Runtime | Synchronous SQLite persistence |

## Browser Platform

The frontend has no React, Vue, Svelte, or build bundler. It uses DOM APIs, Fetch, WebSocket, History, Service Worker, Cache Storage, PushManager, Notifications, Web Audio, native dialogs, and CSS media queries. `public/sw.js` uses cache `joint-bob-v34`; every `APP_SHELL` asset existed during the scan.

Pi supplies models and thinking levels through the SDK. Claude runs with `-p`, `--output-format stream-json`, `--include-partial-messages`, optional resume/model/effort arguments, and `--permission-mode bypassPermissions`.

## Build and Test Tooling

| Tool | Version/configuration | Role |
|---|---|---|
| npm | npm 10; lockfile version 3 | Install, scripts, packing, publication |
| TypeScript compiler | `5.9.3` resolved | Typecheck and build |
| `tsx` | Declared `^4.19.2`; resolved `4.23.12` | Watch mode and TypeScript test loading |
| `node:test` / `node:assert/strict` | Node built-ins | Test framework and assertions |
| Terraform native tests | Terraform `>=1.9,<2.0` | EC2 security assertions |
| Just | External | Installed-node update commands |

No JavaScript/TypeScript linter, repository formatter, coverage tool, browser E2E framework, or frontend typechecker is configured.

## Infrastructure and Delivery

| Technology | Version/pin | Use |
|---|---|---|
| Syncthing | Repository pin `2.1.3`; live scan observed `2.1.1` | Filesystem synchronization |
| Terraform | `>=1.9,<2.0`; observed `1.14.1` | EC2 smoke environment |
| AWS provider | `~>6.0` | Network, EC2, encrypted storage |
| GitHub Actions | `checkout@v4`, `setup-node@v4`, `softprops/action-gh-release@v2` | Tagged releases |
| systemd / launchd | Host native | Linux/macOS user services |
| Tailscale Serve | Host external | Private HTTPS |
| Git | Host external | Worktrees, bundles, releases, deployment |

## Version and Audit Notes

`package-lock.json` and `npm-shrinkwrap.json` contain the resolved integrity graph and must stay synchronized. The explicit public-registry production audit reported zero vulnerabilities across 279 dependency records. The configured proxy audit endpoint returned HTTP 400; that failure is environmental. Syncthing runtime drift remains an operational concern even though the current folder error is explained by ignore semantics.
