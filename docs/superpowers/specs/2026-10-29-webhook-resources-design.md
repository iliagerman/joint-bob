# Webhook files, tools, skills, and memory

## Intent

A webhook can carry its own reusable reference files, executable scripts, selected skills, and persistent lessons. Agents know where resources are and what they are for without the app processing static file contents. The user manages these resources in the existing webhook menu.

This is a design and implementation proposal, not shipped functionality.

## Confirmed requirements

- Upload static files to a webhook, including CSV files.
- Each static file has an editable description explaining its purpose.
- Give the agent each filename, description, and absolute path. Do not automatically parse, summarize, ingest, or run static files.
- Optional memory belongs to one webhook, not a shared collection of webhooks.
- Memory is a persistent Markdown file. Agents use it to retain useful lessons from feedback and issues and update those lessons over time.
- The user can view and edit that Markdown file from the webhook menu.
- Add webhook-specific tools such as Python scripts and instructions for using them.
- Select existing Joint Bob skills, import new skills from Git, or upload a local skill folder.
- Webhook-selected and imported skills must not become enabled or installed elsewhere.

## Proposed implementation decisions

These are builder choices, not additional user requests.

### Ownership and storage

Keep resources on the webhook owner, matching existing node-local webhooks. Management through an active twin routes to the owner; an unavailable owner fails visibly without a local substitute.

Store under `<node data>/webhook-resources/<webhook UUID>/`, outside project folders, global skill directories, and Syncthing resource trees. Resolve through the existing runtime/account data-directory conventions so the execution account can read resources. Use server-assigned IDs and immutable version directories for static files, tools, and skills. Original names are metadata, never trusted storage paths.

Use database metadata for file descriptions, script usage, skill source/provenance, and enabled memory. The canonical memory is `MEMORY.md` on disk; all supported writes use a revision-checked owner API. Do not put file contents in webhook list responses.

Start with existing upload conventions: 4 MiB per file; at most 6 static files, 6 tool files, 20 selected skills; each skill folder at most 4 MiB and 200 files. Descriptions and tool usage are at most 2,000 characters each. Memory is UTF-8 Markdown at most 200,000 bytes. Reject oversized inputs explicitly. Folder uploads preserve relative paths; reject traversal, absolute paths, duplicate paths, symlinks and special files. Git imports enforce the same materialized-folder limits.

Versions referenced by conversations or queued executions are retained after replacement/removal. Removing a resource stops future grants; it cannot erase paths or content already seen by an agent. Do not implement automatic garbage collection in the first version. Deleting a webhook revokes supported memory/tool-context capabilities and future deliveries; retained versions remain until a separate cleanup policy is designed.

### Static files

Upload, download, replace, remove, and edit descriptions from the existing webhook editor. Require a nonempty description on new uploads. A replacement creates a new immutable version; runs accepted earlier keep the previous version.

Provide a resource manifest in the prompt, not the contents. Tell the agent to open files only when relevant, to preserve originals, and to write derived output elsewhere. Do not pass static files through image analysis, attachment digestion, or per-call attachment processing.

This is scoped discovery and app authorization, not filesystem sandboxing against an agent already running under the same OS account. Do not claim that paths are inaccessible to every other process on that account.

### Script tools

A tool consists of an uploaded script, name, description, and usage instructions. Show the script's absolute path and usage to the agent. It runs using the harness's existing shell tooling and permissions, not a new execution service or MCP server.

No execution on upload/import and no automatic dependency installation. Missing Python or dependencies is an explicit execution error, not permission to install software. Never interpolate uploaded names or usage into an app-executed shell command. Users are warned that skills and scripts can execute code when invoked by the agent.

### Skills

Existing selection uses a server-resolved, accessible app skill ID, never a browser-provided filesystem path. Take a webhook-local snapshot of the folder and record its origin. Respect selection-time and execution-time access/revocation checks. Changing webhook selection must not alter the source's activation or sharing settings. To refresh a selected snapshot, explicitly reselect/update it.

Git imports discover skills before import, allow selecting a skill subfolder and optional branch/tag, pin the actual imported commit, and update only on explicit user action. Use the existing hardened Git/discovery primitives but not the global install/share actions. Local-folder upload requires a valid `SKILL.md` and preserves references/scripts beside it. Reject duplicate skill names in one effective webhook skill set with an actionable error; never silently shadow another skill.

Selected skills are added only to the appropriate webhook execution context. Existing independently authorized project resources continue unchanged; this feature neither globally enables webhook skills nor disables existing project resources. This inheritance choice is a proposed default because the user specified destination scope, not replacement of the project baseline.

Carry resource context through the durable prompt queue. Resolve a turn-specific skill overlay through the app's existing harness resource-loading paths for Pi, Claude and Kiro. Never install into global/shared roots or leave a reusable live harness with another webhook's overlay active. Preserve strict resource isolation.

### Memory

Enable memory and create an empty `MEMORY.md`, or initialize it by uploading Markdown. Disabling memory keeps content but stops future grants. The webhook menu shows raw Markdown with edit/save/reload/download and explicit reset confirmation. No separate management dialog is required.

Each update includes the revision read. Return HTTP 409 with the latest revision on conflict; preserve the user's unsaved editor draft. The agent must reread and reconcile before retrying, not overwrite blindly. All supported app and agent writes use the same atomic, serialized revision-check/write path, including across app restarts. Derive a revision from actual file bytes so external edits invalidate old revisions.

Expose an owner-authorized agent CLI with `read` and `write --expected-revision ... --file ...`. `read` returns content, revision, and path. `write` reads the agent's proposed Markdown file and updates only its bound webhook. Do not give the agent a general webhook-management credential or accept a webhook ID supplied by an external payload. The canonical file remains a file, but supported agent updates go through this command to prevent lost updates.

Before work, read memory when enabled. After a useful correction, resolved recurring problem, or new durable constraint, update it. Prefer concise verified lessons, merge duplicates, correct stale statements, and avoid secrets or raw payload dumps. No forced edit after every run. Treat memory as fallible notes, not higher-priority instructions. Untrusted incoming text does not authorize permanent instructions or expanded tool access.

A conversation created by a webhook retains its association for subsequent user feedback. An existing conversation targeted by a webhook receives resources for that webhook turn only; do not permanently attach it or ambiguously assign subsequent manual messages to one of several webhooks. For multiple webhook turns in one conversation, determine association from trusted queue metadata, not transcript text. Forked, copied, or moved conversations must not silently acquire capabilities on another owner. Revocation prevents future API access but cannot remove content already present in history.

### Queueing and lifecycle

Capture immutable static/tool/skill version IDs at acceptance, persist them in queued metadata, and validate ownership/access again when dispatching. Read current memory when work actually starts, not at HTTP acceptance. Memory remains live for revision-checked updates.

Do not rely on a temporary sender WebSocket to maintain bindings or write memory after completion. Normal restart resumes stored pending metadata without replaying a previously started external action. Missing or revoked selected resources produce an explicit failure rather than silently dropping them.

## Management experience

Extend the current webhook editor with resource sections, using existing UI conventions:

- Files with description, size, replace/download/remove.
- Tools with description, script upload, and usage text.
- Skills with existing-skill selection, Git import, and local-folder upload.
- Memory with enable, initial upload, Markdown viewer/editor, save/reload/download/reset.

Use fitted/paginated resource lists where necessary. Every action targets the selected webhook owner. Unsaved edits survive save errors and memory conflicts. Saving unrelated webhook settings, toggling enabled, allowing a sender, or rotating an address must preserve resource selections and memory.

## Existing flow to extend

- `src/webhooks.ts`: webhook schemas, SQLite persistence, prompt text, existing incoming attachment support.
- `src/server/routes/webhooks.ts`: authenticated management and active-twin owner routing.
- `src/server/webhooks.ts`: delivery, attachments, conversation creation, prompt queueing.
- `src/server/conversation-prompt.ts`, `src/prompt-queue.ts`, `src/server/harness-chat.ts`: trusted automation metadata and dispatch lifecycle.
- `src/settings.ts`, `src/scoped-skills.ts`, `src/agent-resources.ts`, `src/harnesses/*/runtime.ts`: scoped resource resolution and harness loading.
- `src/git-resources.ts`: existing safe Git import/discovery primitives. Do not register webhook imports globally.
- `src/agent-capabilities.ts`, `src/webhook-title.ts`, `bin/joint-bob-webhook-title.mjs`: reference patterns for bounded agent capabilities, not permission to reuse title tokens.
- `public/app/webhooks.js`, `public/index.html`: existing webhook management interface.

## Non-goals

No cross-webhook memory sharing, automatic Git updates, vector database, automatic CSV processing, package installation, new MCP service, project-wide skill publishing, cross-machine resource replication, or claim of an OS security sandbox.

## Acceptance criteria

A CSV description/path reaches an agent without CSV content injection. A Python script can be invoked explicitly. Each skill source works through actual harness loading without appearing in another webhook's resources or global inventory. The agent saves a lesson, another run reads it, and the user edits it in the webhook menu. Concurrent user/agent edits conflict visibly without lost updates. Static resources remain stable for queued/running work. All behavior survives restart and routes to the correct webhook owner. Existing incoming webhook attachments and settings operations continue working.
