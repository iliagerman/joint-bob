# Dashboards

## Intent

Users want live dashboards inside Joint Bob, built by describing them to an agent ("vibe coding") rather than writing them. The first real one is for the Contigos project: bugs per day, errors per day and bugs by type, so the user can see whether a fix actually holds or the same issue keeps coming back. Joint Bob must not be fitted to Contigos. Joint Bob provides the infrastructure and a dashboard-creator agent; each dashboard carries its own data logic and layout.

## Goals (user-decided)

- A dashboard can belong to a **conversation**, a **project** or a **workspace**.
- Each of those has a **dashboard mode**: entered from the workspace (next to the workspace in the project list), from the project's actions, and from the conversation. Dashboard mode either creates a dashboard or shows the existing one.
- **Creation and editing** happen in a dedicated view by chatting with a **dashboard-creator agent**. Asking it for changes edits the dashboard.
- The creator agent gets an app-supplied **system prompt**: how to build dashboards in general, the **UI/UX rules**, and **which components and styles to use for widgets**, so every dashboard looks alike. It also gets the **context for its level** (conversation, project or workspace).
- The agent produces **displayable HTML**.
- Widget controls are **bundled into Joint Bob**. No live downloads, ever. The bundled set must be broad enough that the agent never needs anything else.
- Refresh works **without AI where possible**: during creation the agent writes a data script that knows how to query the sources and what output format to print, and Joint Bob re-runs it. Where a script cannot do the job, **AI can refresh** the dashboard.
- **First release: manual refresh only.** Nothing runs automatically. A refresh interval comes later.
- **Settings → Dashboards**, per node: harness, model and effort for the dashboard agent.
- **Sharing** with other nodes and clusters. **Twins receive dashboards by default.**
- **Each node runs dashboards for itself.** Sharing never makes another node run anything, and a node that receives a dashboard does not have to activate it; it keeps using its own.
- So an entity can hold **several dashboards on a node, but only one is visible (active) at a time**.

## Decisions approved with this design (user, 2026-10-24)

1. **Which node runs it:** the node that owns the entity runs its dashboard; a node showing a project that lives elsewhere relays the request to that project's home node.
2. **Received scripts need approval:** a received dashboard runs only after the person reads and approves its current files, and again after every change from its owner. Until then only its layout can be previewed, with no data.
3. **Twins:** on a twin with no dashboard of its own for the entity, the twin's received dashboard is shown by default (still waiting for approval) and becomes active once approved. Other nodes keep it inactive until someone chooses it.

## Non-goals for this release

- Scheduled or interval refresh (keep room for it in the data model; do not build it).
- Alerts or notifications triggered by dashboard values.
- Sending refresh results between nodes. Only the definition is shared.
- Edits on a receiving node flowing back to the dashboard's owner.

## Anti-goals (would be a failure even if it works)

- Dashboard HTML or scripts sending data anywhere from the browser, or the page loading anything from the internet.
- Dashboards that look unrelated to each other or to Joint Bob.
- An AI refresh that costs money without the user knowing it is an AI refresh.
- A received dashboard replacing, hiding or running instead of the node's own.

## Concepts

- **Dashboard definition:** manifest + HTML + refresh method. This is what gets shared. Builder's call on exact file names.
- **Refresh method**, chosen by the creator agent per dashboard:
  - **Script:** a command (in any language available on the node) that prints one JSON document to stdout. No AI involved.
  - **AI:** a stored refresh prompt run as one hidden agent turn that must return the same JSON shape. The view labels such dashboards as AI-refreshed and shows the cost of the last refresh.
- **Data payload:** the JSON from the last successful refresh, with its timestamp. It is node-local and never shared.
- **Activation:** per node, per entity, at most one active dashboard. The node's own dashboard is active by default; received ones arrive inactive.

## Architecture decisions

These are my calls unless marked as the user's; the user may redirect any of them.

### Storage

- Records live in the node's SQLite (`node.db`), like other app data: id, entity kind + id, owner node, origin (own or received-from), refresh method, created/updated, definition digest, active flag per entity.
- Files live in the node's app data directory, one folder per dashboard: the definition files, a node-local `state/` folder the script may use to keep history between runs (for example daily counts after the source data has expired), the last payload, and the last run log.
- Not in the project folder. Project files sync through Syncthing to every node sharing the project, and `.joint-bob/` is excluded from sync, so neither place fits node-local dashboards with selective sharing.

### The creator agent

- A hidden session (internal session id prefix, filtered from conversation lists), opened like the side chat and auto-respond runs. Harness, model and effort come from Settings → Dashboards on the node where it runs.
- The system prompt is delivered with the existing per-harness system-instruction mechanisms (`--append-system-prompt-file` for Claude, agents files for Pi, the profile prompt for Kiro). Content:
  - how dashboards work (definition files, refresh contract, limits);
  - UI/UX rules and the component catalogue with usage examples;
  - the level context listed below;
  - tools to test-run the refresh and preview the result.
- One creator session per dashboard, kept so later edit requests have the history. If the session is gone (for example after a harness's own transcript cleanup), start a new one seeded with the current definition files.
- The agent works on a **draft** copy. The preview shows the draft; the user presses **Save** to make it the live definition. Discarding a draft leaves the live one untouched.
- Level context:
  - **Conversation:** the conversation's transcript and summary, its project's context.
  - **Project:** the project folder, its instruction files, and the names (never values) of its secret accounts' variables.
  - **Workspace:** its projects, and the workspace's secret account variable names.
- The agent may use its normal tools (shell, files, web) while building, so it can explore the sources and test the script.

### Refresh execution

- Manual only: a Refresh button in dashboard mode, and the agent's test-run tool.
- Runs on the current node only.
- Script runs:
  - Run as the entity's OS account in multi-user mode (`spawnInRuntime`).
  - Working directory: the project folder (for project and conversation dashboards) or the workspace folder.
  - Secrets: the entity's secret environment (`agentEnvironment` / `genericSecretEnvironment`), the same rules agents get today.
  - Also given: the dashboard's `state/` path and the previous payload's path.
  - Limits: a timeout (builder's call, about 2 minutes) and a maximum output size (builder's call, a few MB).
  - Supervised: tracked as a subprocess, visible in Tasks while long.
- AI runs: a hidden agent turn with the refresh prompt, under the node's Dashboards settings, recorded in usage/costs like other internal runs.
- Output must be valid JSON. On failure, keep the previous payload, show the error and the run log, and never show stale data as fresh.

### Display

- The dashboard is shown in a sandboxed `<iframe>`:
  - `sandbox="allow-scripts"` with no `allow-same-origin`, so the frame cannot reach the app's cookies, storage or API.
  - The server composes one document for the frame: the bundled component kit inlined, the dashboard's HTML, and the current payload embedded as a JSON script element.
  - Response CSP: `default-src 'none'`, inline script and style allowed, `img-src data:`, no `connect-src`, no `form-action`, no navigation.
  - Refresh reloads the frame with the new payload.
- The app's own CSP gains one narrow frame allowance for this route only (`src/server/http-auth.ts` frame rules). This is a security-sensitive change and needs its own tests.
- Theme follows the app's light/dark mode through the kit's tokens.

### Component kit (bundled)

- One vendored, permissively licensed chart library, pinned and checked into the repo (builder chooses; it must work offline and inline). Plus Joint Bob wrappers that apply the shared style.
- Minimum catalogue:
  - KPI tile with delta vs previous period;
  - line/area time series (single and multi-series, annotations for events such as "fix deployed");
  - bar and stacked bar, horizontal bar for rankings;
  - donut;
  - heatmap (day × hour or day × type);
  - table with sorting and **pagination** (list views page; they do not scroll);
  - status/badge list, text/markdown block;
  - layout grid with section headers;
  - "last refreshed" stamp;
  - empty, loading and error states.
- The kit's API and examples are part of the creator prompt, and the prompt forbids other libraries and external URLs.

### Sharing

- Targets: nodes and clusters (user-decided). Twins receive by default (user-decided), matching how saved commands and admin-owned resources reach twins today.
- What travels: the definition only (manifest, HTML, refresh method). Never the payload, `state/`, run logs or creator transcript.
- Pattern: owner-built per-receiver manifest (as saved commands do) plus digest-addressed, validated file bundles (as skill sharing does).
- On the receiver:
  - The dashboard is listed under its entity as "received from <node>", inactive.
  - The user can preview it, activate it (which deactivates the current one for that entity on this node), refresh it locally, or ignore it.
  - Activation, refreshes and drafts never leave the node.
  - Owner updates replace the received copy. Asking the agent to edit a received dashboard first makes a local copy owned by this node, so the received one keeps tracking its owner.
  - A dashboard whose entity does not exist on the receiver (for example a conversation that never reached it) is stored but not shown.
- Unsharing or deleting at the owner removes the received copy, unless it was copied locally.
- Previewing a received dashboard shows its layout with empty states only. It never runs the received script or AI refresh (my call).

### Access in multi-user mode (my call)

- Anyone who may open the entity may view its active dashboard.
- Creating, editing, refreshing, sharing and deleting require the right to run agents in that entity.
- A workspace dashboard's script runs as the workspace owner's OS account.
- This follows the existing resource-owner checks and does not wait for the `feat/multi-user` branch.

### UI

- **Entry points:**
  - a dashboard button on the workspace group header in the project list (it has no actions today);
  - a "Dashboard" item in the project row menu;
  - a dashboard action in the conversation header.
- **Dashboard mode** is a full view like the Costs view. It contains:
  - entity name;
  - dashboard picker: own + received, active one marked, only when more than one exists;
  - Refresh, with last refreshed time and status, and an AI-refresh label with last cost where it applies;
  - Edit, Share and Delete.
- **Empty state:** a short prompt to describe the dashboard, which opens the creator view.
- **Creator view:** chat with the creator agent next to a live preview of the draft, with Save and Discard. On narrow screens, chat and preview are tabs.
- **Settings → Dashboards:** harness, model, effort for this node, built like the existing sync-check settings.

## Left to the builder

- Exact table schema, file names, route names and CLI/tool names for the agent.
- Choice of chart library within the constraints above.
- Timeout, output size and run-log limits.
- How the creator agent's test-run and preview tools are exposed (a capability CLI scoped to dashboard sessions is the expected shape).
- Visual details within the existing app style.
