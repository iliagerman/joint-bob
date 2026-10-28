# Workspace automation tags

## Agreed requirements

- Scheduled tasks and webhooks accept multiple tags.
- A managed tag list is scoped to a workspace and shared between nodes.
- Users explicitly create managed tags from the automation creation/editing screen or a dedicated Settings section.
- Free-text/manual tags are allowed and are never automatically added to the managed list.
- Tag changes affect future executions only. Past executions retain their tag snapshots.
- Build tag-based execution browsing and statistics now, not just tag assignment. Users can open an execution's conversation and review execution counts and trends.

## Implementation decisions proposed for approval

Use the existing TypeScript, SQLite, Zod, vanilla JavaScript and signed cluster transport. No new dependencies.

### Tags

Managed tags have stable UUIDs, a workspace identity, name, update revision and deletion tombstone. Workspace identity must include the owning node where workspace IDs are mapped on another node; a matching workspace name does not grant access.

Automation assignments distinguish managed IDs from manual strings. Resolve managed names when an execution is accepted. Persist immutable tag names and normalized keys on that execution. Normalize whitespace and case for grouping within a workspace, retain display text, remove duplicates. A manually entered name matching a managed name can group with it without creating or modifying the catalog.

Proposed limits: 80 characters per tag, 20 distinct tags per automation, 500 managed tags per workspace. Reject empty names and duplicate managed names after normalization. Explicit inline creation saves to the catalog immediately and selects the returned tag. Merely typing and saving an automation never writes to the catalog.

Renaming a managed tag changes the label used by future executions, not past snapshots. Deleting retires it from selection; existing assignments show the retired name and require removal or replacement before saving. Future dispatch omits retired tags and preserves other assignments. Existing execution snapshots remain searchable. No automatic historical backfill.

### Execution records

Record each scheduled run and accepted webhook execution separately, including untagged runs. Fields include execution ID, source kind and ID, source-name snapshot, source node, workspace identity, project, harness, request ID, queue/turn ID when assigned, conversation/session IDs, tag snapshots, accepted/start/end times, status and error.

Snapshot tags at schedule claim or webhook acceptance, before asynchronous waits. Later automation edits cannot change a waiting run. Preserve snapshots across queueing and restart. Use the scheduled run ID or a newly allocated webhook request ID as the idempotency key.

Track queued, running, succeeded, failed, cancelled and interrupted states. Webhook delivery is not execution success. Persist lifecycle transitions at the durable queue/harness boundary, not solely through the temporary sender WebSocket. Do not replay an execution to recover missing statistics. After restart, reconcile with durable queue/turn evidence; mark an interrupted execution when completion cannot be established.

A conversation may contain many executions with different tags and unrelated manual turns. Never tag the entire conversation or count it as one execution. Keep execution history when an automation is deleted. Refused webhook calls remain delivery history, not executions.

### Browsing and statistics

Add Settings → Tags with a workspace selector, managed-tag management, and execution browsing. Reuse fitted/paginated list conventions; no additional management dialogs or indefinitely scrolling lists.

Filter by one tag, source kind, specific automation, status and date range. Default to the last 30 days with an explicit all-time option. Include historical/manual tag keys in history selection, separately from the managed catalog. Group summary rows by snapshot tag key. An execution with several tags appears in each matching group but only once in combined totals.

Show execution count, distinct conversation count, queued/running counts, succeeded/failed/cancelled/interrupted counts, success rate, average completed duration, and daily execution trend. Success rate is succeeded divided by succeeded plus failed; cancelled/interrupted/unfinished runs are displayed separately. Duration is start-to-end time, excluding queue wait. Dates use the selected browser timezone and explicit half-open query boundaries.

Show token and cost totals only for usage tied to the execution's request/turn IDs. Missing attribution/pricing is unknown, not zero. Never use whole-conversation usage as an execution total. Aggregate the full filtered result, not just the displayed page. Link each row through existing cross-node conversation navigation. If its conversation is unavailable, retain the row and explain that the conversation cannot be opened.

### Sharing and access

Catalog updates use authenticated, workspace-authorized push-on-change and startup/join/reconnect catch-up. No new polling timers. Reuse workspace identity mapping and sharing selections. One shared project alone does not authorize disclosure of the entire workspace catalog.

Execution history follows project visibility, even when the catalog is shared at workspace scope. Counts and trends must exclude projects the requesting user cannot access. Verify both sender and receiver authorization; do not trust workspace/project IDs supplied by clients. Blocked/revoked peers stop receiving data.

Versioned per-tag updates and tombstones prevent stale catch-up from resurrecting deleted tags. Execution snapshots are immutable; lifecycle revisions are monotonic and cannot move a terminal execution back to running. Reject conflicting snapshots for the same execution ID. Dedupe retransmissions by identity. Older peers must not reject their existing replication batches because they do not understand the new feature.

## Existing code constraints

- `src/cron.ts` stores task inputs as JSON and execution rows separately; owner transfer installs up to 100 existing cron rows.
- `src/webhooks.ts` keeps only 25 delivery entries; that bounded delivery log is not suitable for analytics.
- `src/server/webhooks.ts` waits only until a prompt starts. Actual completion is observed in `src/server/harness-chat.ts`.
- `src/server/shared-workspaces.ts` implements signed, event-driven workspace discovery and maps remote identities through `src/store.ts`.
- Existing replication scopes include projects, accounts and twins, not workspaces. Workspace catalogs need an explicitly authorized scope rather than a global event.
- Existing uncommitted changes include automation provider profiles. Preserve those edits; do not stage entire modified files indiscriminately.

## Verification

Use only the isolated harness documented in `TESTING.md`. Cover tag validation, explicit versus manual creation, immutable execution snapshots, repeated runs in one conversation, correct webhook completion, restart handling, authorization, cross-node catch-up, deletion, aggregate accuracy, and UI navigation/pagination. Run typecheck/build, focused tests, full unit and UI suites before claiming delivery. Record environmental or baseline failures separately.
