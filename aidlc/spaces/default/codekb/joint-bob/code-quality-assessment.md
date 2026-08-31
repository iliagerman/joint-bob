# Code Quality Assessment — Joint Bob

Assessed at commit `c3e9b0508fba185dbc4ab8bb7ad5fa6debadd5fa`. Every figure below is measured, not
estimated.

## Summary

| Dimension | State |
|---|---|
| Type safety | **Strong for `src/`** — `strict: true`, `npx tsc --noEmit` exits 0 with no diagnostics. **Absent for `public/` and `scripts/`**, which are outside `tsconfig`'s `include`. |
| Test count | 140 `*.test.ts` files, flat, no fixtures or shared setup |
| Test value | **Mixed** — roughly 100 genuine integration tests, roughly 40 that assert on source *text* rather than behaviour |
| Coverage measurement | **None** — no `c8`, no `nyc`, no `--experimental-test-coverage`, no threshold, no coverage step in CI |
| Linting / formatting | **None of any kind** |
| CI | **Release-only.** The suite runs only on a `v*` tag push. No CI on push or pull request. |
| Documentation | **Strong at the operator level, absent at the architecture level** |
| Style consistency | **High**, enforced entirely by convention |
| Schema management | **No versioning of any kind**, 17 modules owning parts of a 49-table database, 4 different migration idioms |

## Testing

### Framework and execution

- `node:test` (Node's built-in runner) with `node:assert/strict`
- `npm test` = `node --import tsx --test --test-concurrency=4 test/*.test.ts`
- TypeScript is transpiled on the fly by `tsx`; there is no separate test build
- **No Jest, Vitest, Mocha, Playwright, or Testing Library**

### Three distinct kinds of test, with very different value

**1. Backend integration tests — genuine, and the pattern to follow.**

`test/secrets.test.ts:8-16` is representative:

```ts
async function loadSecrets(tag: string) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `joint-bob-secrets-${tag}-`));
  process.env.PI_WEB_DATA_DIR = dataDir;
  const database = new DatabaseSync(path.join(dataDir, "node.db"));
  database.exec("CREATE TABLE project_types (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY, project_type TEXT); CREATE TABLE project_aliases (alias_id TEXT PRIMARY KEY, project_id TEXT);");
  database.exec("INSERT INTO project_types VALUES ('work'); INSERT INTO projects VALUES ('project-a', 'work'); INSERT INTO project_aliases VALUES ('project-alias', 'project-a');");
  database.close();
  return { dataDir, ...(await import(`../src/secrets.js?${tag}=${Date.now()}-${Math.random()}`)) };
}
```

The mechanics: create a temp dir, point `PI_WEB_DATA_DIR` at it, **hand-build the schema the module
under test expects** (necessary because there is no central schema owner), then **dynamically
re-import the module with a cache-busting query string** so it builds a fresh module-level
`DatabaseSync` handle. Cleanup restores the env var and removes the dir in a `finally`.

This works and gives real signal. Its weakness is the hand-built schema: the test's idea of the
schema and the production schema can drift silently.

**2. Frontend "UI" tests — string assertions against source text, not rendering.**

`test/secrets-ui.test.ts` reads `public/index.html`, `public/app.js`, `public/styles.css`, and
`public/sw.js` **as strings**:

```ts
assert.match(html, /data-settings-tab="github"[^>]*>Secrets/);
assert.match(html, /data-testid="secret-account-dialog"/);
assert.match(app, /api\("\/api\/secrets"\)/);
assert.match(app, /AWS_ACCESS_KEY_ID/);
assert.match(app, /project-type-secrets-button/);
assert.match(app, /project-secrets-button/);
for (const testid of ["secret-variable-name-input", "secret-variable-kind-select", ...]) assert.ok(app.includes(testid));
```

Roughly **40 of the 140 files** follow this `*-ui.test.ts` shape. Nothing is rendered; no DOM
exists. **These tests pass against dead code and fail on a harmless rename.** They pin the *text* of
the client, not its behaviour. In practice they act as a change-detector on `public/`, which is the
only safety net that untypechecked, unlinted 5,854-line file has — so they are not worthless, but
they must not be mistaken for behavioural coverage.

**3. Migration tests — the model for a schema change.**

`test/project-type-migration.test.ts` reconstructs the **exact `CREATE TABLE` the previous build
shipped**, including the dropped `CHECK (project_type IN ('personal', 'work'))` constraint and the
foreign keys on `project_locations` and `project_aliases`, inserts a legacy row, then asserts the
upgrade path preserves it. **A data-model change of any size should follow this pattern.**

### Coverage

**No coverage configuration exists anywhere.** No `c8`, no `nyc`, no
`--experimental-test-coverage` flag, no threshold, and no coverage step in
`.github/workflows/release.yml`. Actual coverage is therefore unknown; the 140-file count is a count
of files, not a measure of coverage.

## Static analysis

**`tsc --noEmit` under `strict: true` is the only automated static check in the repository**, and it
covers `src/**/*.ts` only.

**Not present anywhere in the repo:** `.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `biome.json`,
`.editorconfig`, a `shellcheck` config, or a `husky` directory.

Unchecked by anything: `public/*.js` (9,415 lines including a 5,854-line file) and `scripts/*.mjs`.

Despite the absence of tooling, style is **remarkably consistent** and clearly enforced by
convention: 2-space indent, double quotes, semicolons, named exports only, `.js` extensions on
relative ESM imports, `async function` declarations rather than arrow assignments, `interface` for
object shapes, explicit return types on exported functions, `data-testid` on every interactive
client element, and JSDoc used sparingly and only where the *why* is non-obvious.

## CI/CD

**One workflow: `.github/workflows/release.yml`, triggered only on `v*` tag push.**

Permissions `contents: write`, `id-token: write`. Node 22.23.2 with the npm registry configured.
Steps: `npm ci` → `npm run typecheck` → `npm test` → `npm run build` → `npm pack` and verify that
`package/bin/joint-bob.mjs` exists and `.joint-bob-release` carries `commit=$GITHUB_SHA` →
`sha256sum` → `softprops/action-gh-release@v2` → `npm publish --provenance --access public`.

**There is no CI on push or pull request.** Nothing runs the suite on `main` unless someone cuts a
tag.

The real gate is local and **per-clone, opt-in** (`./scripts/install-git-hooks.sh`):
`scripts/hooks/pre-push`. It carefully resolves `node` from four fallback locations because GUI Git
clients run hooks with a bare `PATH` — the current HEAD commit is precisely that fix
(`fix(hooks): find node when the push comes from a bare environment`). If the pushed commits touch
`src/`, `public/`, or `bin/` without a `package.json` version bump plus a matching `CHANGELOG.md`
section, the gate calls Claude (Haiku) via `scripts/changelog-gate.mjs` to write both files in the
working tree, then **refuses the push**. On a passing gate it records the push, waits for the remote
to confirm the exact commit, then deploys to both installed nodes. Each deploy creates a mode-`0600`
SQLite backup before replacing the installed copy and verifies the reported release.

**Assessment.** The deployment safety story is genuinely good — backup before replace, release
verification, exact-commit confirmation. The *verification* story is weak: nothing enforces a green
suite before code reaches `main`, and the only thing that does enforce it is a hook a contributor
must install by hand.

## Documentation

**Strong at the operator level:**

- `README.md` (6,923 bytes) — install, node pairing (7 numbered steps), managed projects and ticket
  workspaces, private HTTPS, service management for both platforms, development commands,
  deployment, EC2 smoke test, security and data boundaries. **Accurate against the code as
  scanned.**
- `AGENTS.md` (2,114 bytes) — workflow rules (read before editing, preserve unrelated working-tree
  changes, keep Joint Bob state in node-local SQLite, keep repos/transcripts/worktrees/Syncthing
  data filesystem-owned), the required validation trio (`npm run typecheck`, `npm test`,
  `npm run build`), an explicit AI-DLC bypass policy, deployment facts, the changelog contract, and
  the PWA cache rule.
- `CLAUDE.md` (227 bytes) — three lines delegating to the two above.
- Also present: `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `LICENSE`.

**Absent at the architecture level:** **no `docs/` directory, no architecture document, no schema
reference, no API reference.** The 49-table SQLite schema exists only as inline
`CREATE TABLE IF NOT EXISTS` strings scattered across 17 modules; there is no single place to read
it. This CodeKB store is the first consolidated description.

**Inline comments are unusually high-signal.** They encode decisions a redesign must not lose:

- `store.ts:288` — *"Homes created before user-defined types still carry a two-value CHECK; rebuild the table to drop it."*
- `store.ts:292-293` — *"Foreign keys stay off across the swap so dropping the old table does not cascade into project_locations and project_aliases. PRAGMA foreign_keys is a no-op inside a transaction."*
- `store.ts:326` — *"Seeded once, on a brand-new node only, so a deleted type stays deleted across restarts."*
- `store.ts:676` — *"Canonicalise first: an explicit id like `../tickets` must be reduced before the reserved check."*
- `secrets.ts:229` — *"The gh CLI reads GH_TOKEN while most other GitHub tooling reads GITHUB_TOKEN, so one pasted token fills both."*
- `secrets.ts:239` — *"Tells the agent which tool each provider's variables already unlock, so it runs the CLI instead of asking for keys."*
- `github-auth.ts:9` — *"A named credential group. `id` is stable so renaming `label` never breaks project assignments."*
- `github-auth.ts:17` — *"Account upserts carry `{ label, token }`. A bare string is the pre-groups shape and is still accepted from older peers."*
- `github-auth.ts:74` — *"Exactly one group is the default. Projects with no group of their own fall back to it."*
- `github-auth.ts:294-295` — *"Tries each source in order and keeps the first that still has a token, so a deleted group assigned to a project or a project type falls through instead of blocking the chain."*
- `github-auth.ts:465-467` — *"Nothing is ever enrolled automatically: credentials stay on this node until the user asks for a sync."*
- `claude-service.ts:256-258` — *"Syncthing rewrites mtime when a peer advertises new metadata, so a synchronized transcript looks freshly active with no new message. The transcript itself is the only honest record of when this conversation last moved."*
- `claude-service.ts:262-265` — *"A conversation claimed from another node exists under that node's encoded directory as well as this node's, so the same transcript is read twice."*
- `server.ts:1810-1811` — *"A project locked to a peer node must not be edited here. … any node may clear the lock, so it is not a security boundary."*
- `app.js:5677` — *"Generic secret accounts are deliberately node-local; only metadata is ever rendered."*
- `app.js:5681` — *"Brand marks, drawn inline so the offline shell never reaches for a network icon."*
- `terminal-session.ts:22-23` — *"A real pseudo-terminal, so interactive programs, colours, job control, and xterm resize all behave exactly like a local terminal in the project folder."*

---

## Technical Debt Register

24 signals, in the order the scan reported them. Severity is this assessment's judgement.

| # | Signal | Severity |
|---|---|---|
| 1 | **`src/server.ts` is 4,972 lines / 248 KB** — one file holding all 109 routes, the WebSocket server, agent process lifecycle, peer fan-out, task orchestration, and file-editor endpoints. Any credential-model change touches it, and it is the hardest file in the repo to review. | High |
| 2 | **`public/app.js` is 5,854 lines / 261 KB, unbundled, untyped, and outside `tsconfig`'s `include`.** No typechecking, no linting, no module boundaries. Its only safety net is the string-matching `*-ui.test.ts` files. | High |
| 3 | **No schema versioning of any kind**, with 17 modules independently owning parts of a 49-table database and four different migration idioms. | High |
| 4 | **Two parallel credential systems that overlap but share no model.** `github-auth.ts` (555 lines, 9 tables) versus `secrets.ts` (258 lines, 2 tables). Both implement their own AES-256-GCM helpers against the same `~/.joint-bob/secret.key` — the ~30-line key/encrypt/decrypt block is **duplicated verbatim** between `github-auth.ts:40-72` and `secrets.ts:31-63`, with further near-copies in `cluster.ts` and `push.ts`. A GitHub PAT can be stored either way, with different scoping, different replication, and different resolution. | High |
| 5 | **Two incompatible scope models, and neither has a "workspace" tier.** GitHub groups use a **4-tier first-hit-wins chain** (`github-auth.ts:296`) that falls through dangling references; generic secrets use a **2-tier merge** where direct overrides inherited per variable name (`secrets.ts:147`, `:214`). **There is no "workspace" concept anywhere in the domain** — every occurrence of "workspace" in `src/` refers to *ticket* workspaces. **There is no conversation-level scope**, and conversation identity has three shapes. | High |
| 6 | **Project types are node-local; GitHub groups are replicated.** `project_types` (with its `github_group` column) appears in no replication path, while `github_accounts` and `github_project_auth` replicate over a dedicated pipeline. A project type's group assignment does not cross nodes, but the group's token does. | High |
| 7 | **Two replication pipelines with duplicated machinery, plus a third for membership.** `replication_*` and `github_credential_*` implement the same last-writer-wins rule, receipt protocol, and backoff — `Math.min(300, 2 ** Math.min(attempts, 8))` is **byte-identical** at `replication.ts:81` and `github-auth.ts:544`. They differ in enrolment policy (auto-on-read versus explicit-only), which is deliberate but documented only in a code comment. | Medium |
| 8 | **Five hand-rolled tombstone implementations** with no shared abstraction. `store.ts:249` `rekeyProjectState` must know about all of them. **`secret_assignments` has none and is not re-keyed**, so project-alias merges silently strand secret assignments today — a **live defect**. | High |
| 9 | **`resolveProjectAlias` is implemented three times** (`store.ts:120`, `github-auth.ts:237`, `replication.ts:83`) and `compareVersion` twice plus a third inline form. | Medium |
| 10 | **Extremely long single-line statements.** `replication.ts:80`, `:81`, `:92`, `:127`, `:130`, `:155` are single lines of 400–1,900 characters; `secrets.ts:27` creates two tables on one line; `github-auth.ts:505-516` packs the entire inbound conflict resolution into a handful of lines. Correct, but effectively unreviewable in a diff. | Medium |
| 11 | **`node-pty@1.2.0-beta.15`** — a beta native module pinned in production. Native rebuild is a real risk across the Node 22.23.2 pin and two supported platforms. | Medium |
| 12 | **`codemirror@5.65.16`** — CodeMirror 5 is end-of-life; CM6 is the maintained line. | Low |
| 13 | **`package-lock.json` and `npm-shrinkwrap.json` are byte-identical duplicates** (138,169 bytes each). Only the shrinkwrap ships; the pair must be kept in lockstep by hand. | Low |
| 14 | **Gitignored legacy leftovers in the working tree**: `/app.js` (129 KB), `/index.html` (39 KB), `/server.ts` (141 KB), `/styles.css` (49 KB), `/sw.js` — pre-rename copies, ignored at `.gitignore:18-22`. Also `.pi-mobile-web/`, `.pi-mobile-web-attachments/`, and `aidlc.archive/` (100+ tracked files from a superseded AI-DLC workspace). **Grep and IDE search hit these stale copies first.** | Medium |
| 15 | **No CI on push or pull request.** The suite runs only on `v*` tag push. A broken `main` is caught only by the local pre-push hook, which is opt-in per clone. | High |
| 16 | **No linter, formatter, or style config of any kind** — the only static check is `tsc --noEmit` over `src/` only. | Medium |
| 17 | **Secret files are written to disk on every spawn and never cleaned up per session.** `secrets.ts:219-227` rewrites `<dataDir>/secret-files/<accountId>/<VAR_NAME>` at mode `0600` on every agent start; `clearFiles` runs only on account save/delete. | Medium |
| 18 | **`GH_TOKEN` / `GITHUB_TOKEN` cross-fill happens in two places with different semantics**, and because `agentEnvironment` spreads generic secrets last, a generic `github`-provider account **silently overrides the group token for `GH_TOKEN`/`GITHUB_TOKEN` but not for `PI_GITHUB_TOKEN`** — so `gh` and `git push` can authenticate as two different identities. The UI documents this in prose rather than fixing it. **This is the sharpest existing argument for unification.** | High |
| 19 | **`git push` authenticates through a shell script regenerated on every call** (`github-auth.ts:219`), reached only via the injected `GIT_ASKPASS` and `PI_GITHUB_TOKEN`. There is no in-process push, so **the environment contract *is* the push contract**. | Medium (by design, but fragile) |
| 20 | **The embedded terminal gets no credentials at all** (`terminal-session.ts:26`). A user who opens the terminal on a project with secrets assigned finds `aws`, `gcloud`, `gh`, and `git push` unauthenticated, while the agent in the same project is authenticated. | Medium |
| 21 | **Deleting a project type does not clean up its secret assignments**, and `removeProject` cleans up neither `github_project_auth` nor `secret_assignments` — both leave orphaned rows. | High (correctness) |
| 22 | **Reserved-word coupling between project types and the filesystem.** A project type's `id` doubles as a directory name under the managed home. Changing a project's type **physically moves the directory on disk** and reconfigures its Syncthing folder (`relocateProjectType`, guarded by `assertProjectRelocationIdle`, with a rollback path that raises `AggregateError` when rollback itself fails). Anything that reworks project types inherits this coupling. | Medium |
| 23 | **~40 of 140 tests assert on source text rather than behaviour**, so they pass against dead code and fail on harmless renames. A rescoping change will break many of them mechanically without that signalling anything about correctness. | Medium |
| 24 | **`src/app.ts` is a 1-line file and `src/websocket.ts` is 9 lines** — vestigial modules that suggest an abandoned decomposition attempt. | Low |

## Security posture

**Strengths.**

- Every secret at rest is AES-256-GCM encrypted with a node-local key at mode `0600`.
- Secret values never reach the browser; only metadata is served.
- Credentials never cross a node boundary automatically — a deliberate, documented, user-gated step.
- A receiving node **re-encrypts with its own key** rather than sharing key material.
- Inbound peer events are validated twice, independently, and applied idempotently through an inbox
  table.
- A restrictive CSP with no inline script and no external origin.
- `.stignore` keeps every credential-shaped file out of Syncthing at every depth.
- Path-traversal defence at the points it matters: `resolveClaudeSessionPath` rejects anything
  outside `claudeProjectsRoot()`; `saveProjectType` canonicalises an id before the reserved-name
  check so `"../tickets"` is rejected.

**Weaknesses.**

- Credential payloads are encrypted at rest but travel as **plaintext JSON** over the peer link.
  Confidentiality depends entirely on that link being HTTPS, and `README.md` has to warn the
  operator about it rather than the code enforcing it.
- Secret files persist on disk indefinitely after a session ends.
- Project locks are explicitly not a security boundary.
- The two-identity split between `gh` and `git push` (signal 18) is a correctness *and* a security
  issue: work can be pushed under an identity the operator did not intend.
- Orphaned credential rows (signal 21) mean a deleted project's GitHub override and secret
  assignments survive in the database.

## Improvement opportunities

Ordered by leverage, not by effort.

1. **Unify the two credential models** behind one storage shape, one resolution rule, and one
   injection path. Signal 18 is the concrete failure this fixes.
2. **Introduce a schema/migration owner.** Every prior change followed the per-module marker-table
   convention (signal 3); a change touching two credential systems, two tombstone families, and an
   in-flight replication pipeline is the right moment to stop.
3. **Add `secret_assignments` to `rekeyProjectState`, `removeProject`, and `deleteProjectType`**
   (signals 8 and 21). These are live defects independent of any redesign.
4. **Run the test suite on push and pull request** (signal 15). The workflow already exists; only
   the trigger and the publish steps need separating.
5. **Extract the shared crypto helper** used by `secrets.ts`, `github-auth.ts`, `cluster.ts`, and
   `push.ts` (signal 4).
6. **Decide explicitly whether the new scope tiers replicate**, and record the decision (signals 6
   and 7). Today the answer differs per table with no stated rationale outside code comments.
7. **Decide whether the embedded terminal should be credentialed** (signal 20). It is a one-line
   change with a real security consequence, so it deserves a deliberate answer either way.
8. **Add a linter and formatter, and bring `public/` into a typechecked or at least linted world**
   (signals 2 and 16). The style is already consistent; tooling would only make it enforceable.
9. **Split `src/server.ts`** along the seams the route table already suggests: auth, cluster,
   projects, credentials, sessions, tasks, files (signal 1).
10. **Replace the `*-ui.test.ts` string assertions with rendering tests** for the parts of the
    client that carry logic (signal 23).
