# Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a conversation, project or workspace hold manually refreshed, agent-built HTML dashboards that render from a bundled component kit, with per-node creator settings, sharing to nodes and clusters, and approval before a received dashboard runs.

**Architecture:** A new `src/dashboards/` module owns the contract, SQLite records, node-local files, the script and AI refresh runners, and sharing. A creator agent runs in a hidden harness session with Joint Bob's system prompt; it writes a draft that the user saves. The dashboard HTML is served as a same-origin frame with a locked CSP and sandbox, and receives its payload embedded in the document. A bundled `public/dashboard-kit/` provides every widget; nothing loads from the network.

**Tech Stack:** TypeScript (Node, Express, `node:sqlite`, zod), vanilla-JS UI in `public/app/`, `node:test`-style tests under `test/` (follow the existing `test/*.test.ts` files for the exact runner), one vendored chart library pinned under `public/dashboard-kit/vendor/`.

**Spec:** `docs/superpowers/specs/2026-10-24-dashboards-design.md`

## Global Constraints

- Follow `AGENTS.md` and `CLAUDE.md`: explicit code, no defensive fallbacks, validation only at real boundaries (user input, harness/process output, network, persistence), functions at most ~50 lines, Conventional Commits, atomic commits.
- Work on local `main` in `/Users/iliagerman/JointBob/personal/joint_bob`. No worktree and no new branch. Stage only files a task names; other sessions have uncommitted edits in the same checkout. Do not push.
- Refresh is manual only. No timer, no scheduled run, no run on share or on startup.
- Dashboard HTML and kit code make no network requests. The creator prompt forbids other libraries and outside URLs.
- A received dashboard never runs before approval, and never runs on the receiving node unless that node is its owner or the user has approved its current definition digest.
- A node runs only its own dashboards. Sharing sends the definition only: never payloads, `state/`, run logs or creator transcripts.
- Twins receive dashboards by default; the receiving twin activates a received dashboard only when it has no dashboard of its own for that entity.
- Dashboard definitions, payloads and run logs are node-local files under the app data directory, not under the project folder (`.joint-bob/` is excluded from sync).

## Review Focus

1. A script prints non-JSON, empty output, a huge output, or never exits. The previous payload must stay live and the failure must show; the process must be killed at the timeout. Covered by Task 4.
2. A string in the payload contains `</script>` or HTML markup. The kit must render it as text. Covered by Task 8.
3. A dashboard whose entity (conversation or project) is deleted while the dashboard exists. Listings must hide it and the frame must not load. Covered by Task 2.
4. Save and Refresh racing: a refresh reads the draft while Save renames it. The live definition must change atomically and a refresh must use one consistent definition. Covered by Task 3 and Task 10.
5. A received dashboard whose owner later changes the script after the user approved the old one. It must stop running until approved again. Covered by Task 12.

---

### Task 1: Dashboard contract

**Files:**
- Create: `src/dashboards/contract.ts`
- Test: `test/dashboards-contract.test.ts`

**Interfaces:**
- Produces: `dashboardManifestSchema`, `DashboardManifest`, `DashboardEntityKind` (`"conversation" | "project" | "workspace"`), `RefreshMethod` (`{ method: "script"; command: string } | { method: "ai"; prompt: string }`), `parsePayload(text: string): DashboardPayload` (throws on invalid JSON or a non-object), `DashboardPayload = Record<string, unknown> & { generatedAt: string }`.

- [ ] **Step 1: Write the failing test**

Assert: a manifest with `entity.kind = "workspace"` and a `script` refresh parses; `kind = "folder"` is rejected; `parsePayload("[1]")` throws; `parsePayload("{\"generatedAt\":\"2026-10-24T09:00:00Z\"}")` returns the object; `parsePayload("")` throws.

- [ ] **Step 2: Run it and confirm it fails** (module missing).

- [ ] **Step 3: Implement the zod schemas and `parsePayload` in `contract.ts`.** The manifest is `{ id: uuid, entity: { kind, id: string 1..300 }, title: string 1..120, refresh: RefreshMethod }` with `.strict()`. `command` is 1..2000 chars; `prompt` is 1..20000 chars.

- [ ] **Step 4: Run the test and confirm it passes.**

- [ ] **Step 5: Commit**

```bash
git add src/dashboards/contract.ts test/dashboards-contract.test.ts
git commit -m "feat(dashboards): add dashboard manifest and payload contract"
```

---

### Task 2: Dashboard records in SQLite

**Files:**
- Create: `src/dashboards/store.ts`
- Modify: `src/store.ts` (call `ensureDashboardSchema(db)` next to `ensureProjectMetadataSchema(db)` at `src/store.ts:573`, `:643` and `:1009`, following the same pattern)
- Test: `test/dashboards-store.test.ts`

**Interfaces:**
- Consumes: `DashboardEntityKind`, `RefreshMethod` from Task 1.
- Produces: `ensureDashboardSchema(db: DatabaseSync): void`; `DashboardRecord` with fields `id, entityKind, entityId, ownerNodeId, origin: "own" | "received", receivedFrom?: string, refresh: RefreshMethod, definitionDigest, approvedDigest?: string, active: boolean, title, createdAt, updatedAt`; `insertDashboard(db, record)`, `dashboardsFor(db, entityKind, entityId): DashboardRecord[]`, `activeDashboard(db, entityKind, entityId): DashboardRecord | undefined`, `activateDashboard(db, id): void` (deactivates the other row for the same entity in one transaction), `deleteDashboard(db, id): void`, `removeEntityDashboards(db, entityKind, entityId): void`.

Table `dashboards` with a partial unique index `UNIQUE(entity_kind, entity_id) WHERE active = 1`.

- [ ] **Step 1: Write the failing test.** Insert two dashboards for one conversation; activate the second; assert only the second is active. Insert a received dashboard with `approvedDigest` unset; assert `activateDashboard` throws with message `Dashboard definition is not approved`. Assert `removeEntityDashboards` deletes rows for that entity only.

- [ ] **Step 2: Run it and confirm it fails.**

- [ ] **Step 3: Implement the schema and functions.** `activateDashboard` throws when `origin === "received"` and `approvedDigest !== definitionDigest`; that is the only approval gate in this layer. Use `db.exec` with `CREATE TABLE IF NOT EXISTS` and `CREATE UNIQUE INDEX IF NOT EXISTS`, and transactions with `BEGIN IMMEDIATE`.

- [ ] **Step 4: Run the test and confirm it passes.**

- [ ] **Step 5: Commit**

```bash
git add src/dashboards/store.ts src/store.ts test/dashboards-store.test.ts
git commit -m "feat(dashboards): store dashboard records with one active per entity"
```

---

### Task 3: Node-local dashboard files

**Files:**
- Create: `src/dashboards/files.ts`
- Test: `test/dashboards-files.test.ts`

**Interfaces:**
- Consumes: the app data directory helper in `src/data-directory.ts` (use the function the other node-local stores use; check its export name).
- Produces: `dashboardRoot(id: string): string`; `writeDefinition(id, { manifest, html }): void` (writes `live/manifest.json` and `live/index.html` through a temporary directory and one rename, so a reader never sees a half-written definition); `writeDraft(id, { manifest, html }): void` (same, under `draft/`); `promoteDraft(id): void` (renames `draft/` over `live/` atomically and returns the new definition digest); `discardDraft(id): void`; `readLiveDefinition(id): { manifest, html, digest }`; `readPayload(id): DashboardPayload | undefined`; `writePayload(id, payload): void`; `writeRunLog(id, text): void` (keeps the last run only); `stateDir(id): string`.

The definition digest is a SHA-256 over `manifest.json` and `index.html` bytes, computed on read.

- [ ] **Step 1: Write the failing test.** Write a live definition, write a draft, promote it, assert `readLiveDefinition` returns the draft's HTML and that the digest changed. Assert `discardDraft` leaves the live copy unchanged. Assert `readPayload` returns `undefined` before any payload exists.

- [ ] **Step 2: Run it and confirm it fails.**

- [ ] **Step 3: Implement with `node:fs` (`mkdtemp` in the dashboard root, `renameSync` to swap). Reject ids that are not UUIDs before building any path.**

- [ ] **Step 4: Run the test and confirm it passes.**

- [ ] **Step 5: Commit**

```bash
git add src/dashboards/files.ts test/dashboards-files.test.ts
git commit -m "feat(dashboards): add node-local definition, draft and payload files"
```

---

### Task 4: Script refresh runner

**Files:**
- Create: `src/dashboards/script-run.ts`
- Test: `test/dashboards-script-run.test.ts`

**Interfaces:**
- Consumes: `parsePayload` (Task 1), `writePayload` / `writeRunLog` / `stateDir` (Task 3), `spawnInRuntime` / `runtimeCommand` from `src/account-runtime.ts:91-133`, `agentEnvironment(projectId, conversationId?)` from `src/secrets.ts:583-591`.
- Produces: `runScriptRefresh(input: { id: string; command: string; cwd: string; projectId?: string; conversationId?: string; accountIds?: string[] }): Promise<{ ok: true; payload: DashboardPayload } | { ok: false; error: string }>`.

Behaviour: runs `sh -c <command>` in `cwd` with the secret environment and two extra variables, `JOINT_BOB_DASHBOARD_STATE` (the state directory) and `JOINT_BOB_DASHBOARD_PREVIOUS` (the previous payload path, if any). Timeout 120 000 ms; stdout cap 4 MiB; stderr is kept for the run log. On success it writes the payload and returns it. On any failure (non-zero exit, timeout, cap exceeded, invalid JSON) it leaves the previous payload in place, writes the run log, and returns the error. Killing on timeout uses the same process-group kill as `src/subprocess.ts`.

- [ ] **Step 1: Write the failing tests** using a real `sh` command:
  - `printf '{"generatedAt":"2026-10-24T09:00:00Z","n":1}'` succeeds and the payload is stored.
  - `printf 'not json'` fails with an error mentioning JSON and keeps the previous payload.
  - `sleep 5` with a 200 ms test timeout fails with a timeout message (make the timeout a parameter with the 120 s default only for tests).
  - Output of 5 MiB fails with the size message.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement.** Use `spawnInRuntime` and the existing subprocess tracking so the child is visible in Tasks while long. Do not add retries.

- [ ] **Step 4: Run the tests and confirm they pass.**

- [ ] **Step 5: Commit**

```bash
git add src/dashboards/script-run.ts test/dashboards-script-run.test.ts
git commit -m "feat(dashboards): run script refreshes with timeout and output limits"
```

---

### Task 5: AI refresh runner

**Files:**
- Create: `src/dashboards/ai-run.ts`
- Test: `test/dashboards-ai-run.test.ts`

**Interfaces:**
- Consumes: `internalSessionId()` from `src/internal-sessions.ts`, `getHarness` / `getHarnessRuntime` from `src/harnesses.ts`, `parsePayload` (Task 1), `writePayload` / `writeRunLog` (Task 3), dashboard settings from Task 6 (`DashboardCreatorSettings`).
- Produces: `runAiRefresh(input: { id: string; prompt: string; cwd: string; projectId: string; conversationId?: string; accountIds?: string[]; settings: DashboardCreatorSettings; signal: AbortSignal }): Promise<{ ok: true; payload: DashboardPayload } | { ok: false; error: string }>`.

Behaviour: opens a throwaway harness session with an internal id, configures provider/model/thinking from `settings`, leaves tools on because a refresh may need to query its sources, sends the refresh prompt with the instruction "Return ONLY the JSON payload", collects the final text, parses with `parsePayload`, then disposes the session. Follow `src/server/auto-respond-run.ts:27-80` for the open / configure / prompt / dispose sequence, timeout and abort handling. A 20-minute timeout matches the auto-responder's tool timeout.

- [ ] **Step 1: Write the failing test** with `JOINT_BOB_*`-style override is NOT used. Instead inject the runtime through a parameter `openSession` defaulting to the real harness lookup, and test that: a fake session returning valid JSON yields `ok: true`; a fake session returning prose yields `ok: false` with a message; abort rejects with a cancellation error.

- [ ] **Step 2: Run it and confirm it fails.**

- [ ] **Step 3: Implement.** Only the production path calls `getHarnessRuntime`; the tests pass a fake session through the parameter.

- [ ] **Step 4: Run the tests and confirm they pass.**

- [ ] **Step 5: Commit**

```bash
git add src/dashboards/ai-run.ts test/dashboards-ai-run.test.ts
git commit -m "feat(dashboards): refresh dashboards with a hidden agent turn"
```

---

### Task 6: Per-node Dashboards settings

**Files:**
- Modify: `src/settings.ts` (add `DashboardCreatorSettings`, `dashboardCreatorSchema`, a `dashboards` entry in the settings read/write functions next to `syncCheck` at `:58-93`, `:197`, `:228`, `:498`, `:616`, `:647`)
- Modify: `public/app/settings.js` (a Dashboards panel built with `createConversationControls`, like the sync check panel at `:283-320`)
- Modify: `public/index.html` (a `data-settings-tab="dashboards"` entry and panel next to the sync check markup at `:900-910`)
- Test: `test/dashboards-settings.test.ts`

**Interfaces:**
- Produces: `DashboardCreatorSettings { harnessId: string; provider: string; modelId: string; thinkingLevel: ThinkingLevel }`, `dashboardCreatorSchema` (`.strict()`), `dashboardCreatorSettings(): DashboardCreatorSettings`, validated on save the same way `validateSyncCheck` does (the harness must be able to run on this node).
- Default: the first runnable harness, Pi preferred, with that harness's default model, same as `defaultSyncCheck`.

- [ ] **Step 1: Write the failing test.** Save settings with a valid harness; read them back. Save with a harness that cannot run here; assert rejection. Save with an unknown key; assert rejection (strict schema).

- [ ] **Step 2: Run it and confirm it fails.**

- [ ] **Step 3: Implement the settings module changes and the UI panel.** The panel only edits `dashboards`; it does not change any other setting.

- [ ] **Step 4: Run the test and confirm it passes. Then run the UI settings test that already exists for sync check (`test/` file that covers `syncCheck` in settings) to confirm nothing else changed.**

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts public/app/settings.js public/index.html test/dashboards-settings.test.ts
git commit -m "feat(dashboards): add per-node dashboard creator settings"
```

---

### Task 7: Creator system prompt

**Files:**
- Create: `src/dashboards/creator-prompt.ts`
- Create: `src/dashboards/creator-rules.md` (the general dashboard and UI/UX rules, read at build time; keep it the single place to edit the style guide)
- Test: `test/dashboards-creator-prompt.test.ts`

**Interfaces:**
- Consumes: `DashboardEntityKind` (Task 1), the component catalogue from Task 8 (`public/dashboard-kit/catalog.json`).
- Produces: `buildCreatorInstructions(input: { level: DashboardEntityKind; context: string }): string`. `context` is the level context the caller assembles (Task 10).

The text covers: what a dashboard is (definition files, the payload contract, the refresh methods and when to use each), the component catalogue, the rule that the page uses only kit components and no outside URLs, how to test-run a refresh with the capability CLI from Task 10, and the level context.

- [ ] **Step 1: Write the failing test.** Assert the output contains the catalogue component names from `catalog.json`, the words "no outside URLs" (case-insensitive), the given level context, and that it names `joint-bob-dashboard test-run`.

- [ ] **Step 2: Run it and confirm it fails.**

- [ ] **Step 3: Implement. Read the rules file with `readFileSync` relative to the module, once at import.** Keep the function under 50 lines.

- [ ] **Step 4: Run the test and confirm it passes.**

- [ ] **Step 5: Commit**

```bash
git add src/dashboards/creator-prompt.ts src/dashboards/creator-rules.md test/dashboards-creator-prompt.test.ts
git commit -m "feat(dashboards): add dashboard creator system prompt"
```

---

### Task 8: Bundled component kit

**Files:**
- Create: `public/dashboard-kit/kit.js`
- Create: `public/dashboard-kit/kit.css`
- Create: `public/dashboard-kit/catalog.json` (component name, props, one example each)
- Create: `public/dashboard-kit/vendor/<chart library>.min.js` and `public/dashboard-kit/vendor/LICENSE` (the builder picks one permissive, offline-capable library and records its version in a header comment in `kit.js`)
- Test: `test/dashboards-kit.test.ts`

**Interfaces:**
- Produces, on `window.JointBobKit`: `kpi(opts)`, `timeSeries(opts)`, `bar(opts)`, `stackedBar(opts)`, `donut(opts)`, `heatmap(opts)`, `table(opts)` (sortable, paged), `badges(opts)`, `text(opts)`, `grid(opts)`, `section(opts)`, `lastRefreshed(payload)`, `stateView(kind)` for `empty | loading | error`. Every function returns a DOM node. All text goes through `textContent`; no `innerHTML` with payload values.
- The payload is read from `<script type="application/json" id="payload">` in the frame.
- Theme tokens come from `kit.css` custom properties, light and dark.

- [ ] **Step 1: Write the failing test** that loads `kit.js` into a DOM (follow the existing UI-test setup under `test/ui/`), renders `table` with a value `"</script><img src=x onerror=alert(1)>"` and asserts that the text appears as text and no `img` element is created. Also assert `kit.js` and `kit.css` contain no `http://`, `https://` or `//` URLs except the license comment.

- [ ] **Step 2: Run it and confirm it fails.**

- [ ] **Step 3: Implement the kit and the catalogue.** Vendor the chart library; do not fetch it.

- [ ] **Step 4: Run the test and confirm it passes.**

- [ ] **Step 5: Commit**

```bash
git add public/dashboard-kit test/dashboards-kit.test.ts
git commit -m "feat(dashboards): bundle the dashboard component kit"
```

---

### Task 9: Frame route and CSP

**Files:**
- Create: `src/server/dashboards.ts` (route module; register it next to the other routers in `src/server/routes/` the way `routes/cron.ts` is registered in `src/server/core.ts`)
- Modify: `src/server/http-auth.ts:80-85` (allow same-origin framing for the dashboard frame path only)
- Test: `test/dashboards-frame.test.ts`

**Interfaces:**
- Consumes: `readLiveDefinition`, `readPayload` (Task 3), `dashboardRoot` (Task 3), `activeDashboard` (Task 2).
- Produces: `GET /api/dashboards/:id/frame` returns the composed document. It is built from the kit's `kit.css`, `kit.js`, the vendored library, the dashboard `index.html`, and the payload in `<script type="application/json" id="payload">`. Response headers:
  - `Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'`
  - `X-Frame-Options: SAMEORIGIN` for this path only, via the matching rule in `http-auth.ts`.
- The `/api/dashboards/:id/frame` route serves only the active dashboard's live definition for that id.

- [ ] **Step 1: Write the failing tests.**
  - Composed document contains the payload JSON and the kit script.
  - A payload containing `</script>` is escaped inside the JSON element (replace `<` with `<` when embedding).
  - The response CSP has no `connect-src` and no `default-src` other than `'none'`.
  - `X-Frame-Options` is `SAMEORIGIN` for the frame path and `DENY` for `/api/dashboards/:id` (the JSON API).

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement.** The frame is loaded by the UI as `<iframe sandbox="allow-scripts" src="/api/dashboards/:id/frame">`. Do not add `allow-same-origin`.

- [ ] **Step 4: Run the tests and confirm they pass.**

- [ ] **Step 5: Commit**

```bash
git add src/server/dashboards.ts src/server/http-auth.ts src/server/core.ts test/dashboards-frame.test.ts
git commit -m "feat(dashboards): serve dashboard frames with a locked CSP"
```

---

### Task 10: Creator session, draft and capability CLI

**Files:**
- Create: `src/dashboards/creator-session.ts` (open or resume the creator session for one dashboard, send a message, return the draft)
- Create: `src/server/dashboards-creator.ts` (routes: `POST /api/dashboards/:id/creator/message`, `POST /api/dashboards/:id/draft/save`, `POST /api/dashboards/:id/draft/discard`, `POST /api/dashboards/:id/refresh`)
- Create: `bin/joint-bob-dashboard` (capability CLI with `test-run` and `show-draft`; token environment variable as in `src/ntfy-agent.ts:13-30`)
- Test: `test/dashboards-creator.test.ts`

**Interfaces:**
- Consumes: `buildCreatorInstructions` (Task 7), `runScriptRefresh` (Task 4), `runAiRefresh` (Task 5), draft/promote functions (Task 3), `internalSessionId` (`src/internal-sessions.ts`), the agent-capability registration pattern (`src/agent-capabilities.ts:105-157`).
- Produces: `openCreatorSession(dashboardId, level): Promise<CreatorSession>`; `sendCreatorMessage(dashboardId, text): Promise<{ replyText: string; draftUpdated: boolean }>`; the CLI commands `test-run` (runs the draft's refresh against draft, prints the payload or the error) and `show-draft` (prints the draft manifest path).

The creator session is one hidden session per dashboard, kept so later requests keep history. Save promotes the draft; a refresh always reads the live definition (Task 3 guarantees the swap is atomic).

- [ ] **Step 1: Write the failing tests** with a fake harness session:
  - sending a message returns the reply and marks the draft updated only when the agent wrote a draft file;
  - Save promotes the draft and the new digest differs; Discard leaves the live definition unchanged;
  - `test-run` against a draft with a failing script returns the error and writes no payload;
  - a dashboard that is not active cannot be refreshed through its id (refresh requires the active dashboard for its entity).

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement the routes, the session module and the CLI.** The creator session uses the entity's project folder as its working directory, the same as auto-respond.

- [ ] **Step 4: Run the tests and confirm they pass.**

- [ ] **Step 5: Commit**

```bash
git add src/dashboards/creator-session.ts src/server/dashboards-creator.ts bin/joint-bob-dashboard test/dashboards-creator.test.ts
git commit -m "feat(dashboards): add creator sessions with draft save and test-run"
```

---

### Task 11: Dashboard mode UI and entry points

**Files:**
- Create: `public/app/dashboards.js` (dashboard mode view: picker, Refresh with status, Edit, Share, Delete, empty state; creator view with chat, draft preview, Save and Discard; narrow-screen tabs)
- Modify: `public/app/project-list.js` (a Dashboard button on the workspace group header in `projectGroupElement`, `:100-135`; a Dashboard item in `projectMenuItems`, `:273-330`)
- Modify: `public/index.html` (a Dashboard action in the conversation header `.chat-actions`, `:253-268`; the dashboard view container)
- Test: `test/ui/dashboards-ui.test.ts`

**Interfaces:**
- Consumes: the creator and refresh routes (Task 10), frame route (Task 9), `public/app/api.js` for requests.
- Produces: `openDashboardMode(entityKind, entityId)`.

The Refresh button shows the last refreshed time and status; an AI-refreshed dashboard shows its last run cost where the usage data provides it. The frame is an `<iframe sandbox="allow-scripts">`, reloaded after each refresh.

- [ ] **Step 1: Write the failing UI test** following the existing `test/ui/*` setup: an empty entity shows the prompt to describe a dashboard; an entity with an active dashboard shows its frame with the sandbox attribute exactly `allow-scripts`.

- [ ] **Step 2: Run it and confirm it fails.**

- [ ] **Step 3: Implement the view and the three entry points.** Use `public/app/usage-dashboard.js` for how a full view is mounted; keep the component under the 50-line function rule by splitting into small render functions.

- [ ] **Step 4: Run the UI test and confirm it passes.**

- [ ] **Step 5: Commit**

```bash
git add public/app/dashboards.js public/app/project-list.js public/index.html test/ui/dashboards-ui.test.ts
git commit -m "feat(dashboards): add dashboard mode and entry points"
```

---

### Task 12: Sharing, receiving and approval

**Files:**
- Create: `src/dashboards/sharing.ts` (per-receiver manifest, twin default, received-copy lifecycle)
- Create: `src/server/dashboards-sharing.ts` (routes: `PUT /api/dashboards/:id/share`, `POST /api/dashboards/:id/approve`, `POST /api/dashboards/:id/activate`)
- Modify: `src/dashboards/store.ts` (`approvedDigest` is already present from Task 2; add `approveDashboard(db, id, digest)`)
- Modify: `src/server/cluster-v2.ts` or the saved-command announce path only if the sharing announce needs a hook; mirror `src/server/saved-commands.ts:53-90` and `src/saved-commands.ts` for the manifest shape. The implementer confirms the exact announce function by reading those files first.
- Test: `test/dashboards-sharing.test.ts`

**Interfaces:**
- Consumes: `commandSelectionSchema`-style selection (nodes and clusters only), `remoteTerminalSettings`-style twin check (`twinMayReceive` in `src/cluster-sharing-policy.ts:382-392`), `activateDashboard` / `approveDashboard` (Task 2).
- Produces: `shareDashboard(db, dashboardId, selection): DashboardShareManifest`; `receiveDashboard(db, manifest, bundle): DashboardRecord` (origin `received`, inactive, `approvedDigest` unset); `approveDashboard(db, id, digest): void`.

Rules implemented here:
1. Only the definition travels (manifest + `index.html` bundle, digest-checked); never payloads, `state/`, run logs or transcripts.
2. A received dashboard is inactive and unapproved on arrival. Approval is bound to the digest the user saw. An owner change alters the digest, which clears approval, deactivates the received copy and keeps its last payload visible as stale.
3. When the receiving node is a twin and has no dashboard for the entity, the received dashboard is activated once approved.
4. Owner-side unshare or delete removes received copies that were not edited locally.
5. A received dashboard for an entity the receiver does not have is stored and hidden.

- [ ] **Step 1: Write the failing tests:**
  - an owner update changes the digest and the received copy becomes inactive and unapproved;
  - activation on an unapproved received dashboard fails;
  - a twin with no own dashboard auto-activates a received one after approval; a non-twin does not;
  - a received dashboard for a missing entity is stored and not returned by listings;
  - unshare removes the received copy only when it was not edited locally.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement.** The bundle transfer reuses the digest-addressed approach of skill sharing (`src/skill-sharing.ts`); do not reuse its file paths.

- [ ] **Step 4: Run the tests and confirm they pass.**

- [ ] **Step 5: Commit**

```bash
git add src/dashboards/sharing.ts src/dashboards/store.ts src/server/dashboards-sharing.ts test/dashboards-sharing.test.ts
git commit -m "feat(dashboards): share definitions with approval before received dashboards run"
```

---

### Task 13: Owner routing and multi-user access

**Files:**
- Modify: `src/server/dashboards.ts` and `src/server/dashboards-creator.ts` (owner check before refresh and creator routes)
- Test: `test/dashboards-access.test.ts`

**Interfaces:**
- Consumes: the owner-routing helper conversations use (read `src/conversation-ownership.ts` and `src/server/cluster-helpers.ts`; the implementer uses the existing helper and does not write a new one), `resourceOwner` checks used by secrets.
- Produces: `assertCanRunDashboard(actor, dashboard)` and `assertCanEditDashboard(actor, dashboard)`.

Rules:
1. Refresh and creator routes run on the entity's owner node. A request that arrives on another node is routed to the owner with the existing helper; no fallback.
2. Anyone who can open the entity may view the active dashboard frame.
3. Create, edit, refresh, share and delete require the right to run agents in that entity.
4. A workspace dashboard's script runs as the workspace owner's OS account, through `spawnInRuntime`.

- [ ] **Step 1: Write the failing tests** for each rule, with two actors on one node and one actor on a second node.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement the checks as calls at the top of each route handler.**

- [ ] **Step 4: Run the tests and confirm they pass.**

- [ ] **Step 5: Commit**

```bash
git add src/server/dashboards.ts src/server/dashboards-creator.ts test/dashboards-access.test.ts
git commit -m "feat(dashboards): route refreshes to the owner node and check access"
```

---

### Task 14: Verification

**Files:** none changed unless a check fails.

- [ ] **Step 1: Run the new dashboard tests.** Run the test command from `package.json` filtered to `dashboards`. Expected: all pass.

- [ ] **Step 2: Run the full suite** (`npm test`, and the UI suite named in `TESTING.md`). Expected: no new failures. Failures that already exist on main are listed as baseline, not as this feature's problem.

- [ ] **Step 3: Typecheck and lint** (the `tsc` and lint commands in `package.json`). Expected: clean.

- [ ] **Step 4: Manual check in the running app** with the `run` skill: create a dashboard on a conversation, save it, refresh it, confirm the frame shows the payload, and confirm a `</script>` string in a payload shows as text.

- [ ] **Step 5: Report** the results to the user with the exact commands and their output summaries. Do not claim success for any step that did not run.
