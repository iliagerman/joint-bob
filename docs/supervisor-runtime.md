# Supervisor runtime

Installed Linux and macOS services start the stable `scripts/supervisor-service.mjs` bootstrap from the initial installation root. The supervisor owns the app and background task process groups. App generations are immutable directories under `app/releases`; generations are retained and disk cleanup is a follow-up concern.

The active generation is committed in node-local `supervisor.db` only after its process starts and loopback `/api/health` reports `status: ok` with the expected release. Activation gracefully stops the old app, starts and verifies the candidate, and rolls back to the prior app on failure. Background workers and their log files are untouched. A disconnected activation client does not cancel the supervisor transaction.

A native service restart or reboot loads the last committed generation. A candidate interrupted before commit is not selected. Running tasks are interrupted by supervisor crash, reboot, or manual native-service restart; persisted active task rows become `unknown` and commands are never replayed automatically. If an installed app crashes while the supervisor remains running, the supervisor restarts the committed app after one second without stopping task workers. Intentional replacement and shutdown never trigger that policy; failed restart attempts are logged and retried at the same bounded interval.

Ordinary `joint-bob install` updates only the app generation. It does not stop or restart the native service and does not replace the stable installation root. Supervisor component byte changes are refused before app preparation with a maintenance-reinstall message. Supervisor binaries are not automatically upgraded and this unit provides no force or maintenance mode. The first migration from a legacy unsupervised installation still uses native service activation.

## Local control

Control uses the mode-0600 Unix socket in the data directory. Administrative actions include `status`, `activate-release`, `replace-app`, task start/list/read/output/stop, and completions. Scoped task tokens can access only their identity's task actions. Credentials and command environments are not returned in status or persisted with task metadata.

The CLI fixture remains available:

```text
node scripts/joint-bob-supervisor.mjs --data-dir <absolute> --app <absolute> --cwd <absolute>
```

## Harness delivery contract

Claude, Pi, and Kiro receive local capabilities through the shared agent-capability table. Each adapter wires the generic instruction-file and environment builders once; future capabilities are added to that table rather than to individual adapters. Capability environment is scoped to the logical project and conversation, independent of which harness continues it. Task access uses a freshly minted scoped token and never exposes the supervisor administrator token. Pi refreshes both credentials and capability tokens before each subsequent user message.

## Task CLI

When the local supervisor is initialized, agents can run commands that must outlive a turn with:

```text
node "$JOINT_BOB_TASK_CLI" start [--id UUID] [--name label] -- command args
node "$JOINT_BOB_TASK_CLI" status [id] [--node UUID]
node "$JOINT_BOB_TASK_CLI" output id [--offset N] [--limit N] [--node UUID]
node "$JOINT_BOB_TASK_CLI" stop id [--node UUID]
```

Ordinary integrated shell tools for Pi, Claude, and Kiro are automatically routed through the configured supported native shell adapter. A command remains in the foreground for up to five seconds; if it is still running, the same process continues under supervisor ownership and its eventual exit produces an automatic follow-up. Commands that finish synchronously do not produce an automatic follow-up and are excluded from visible task queries before pagination, so short records cannot hide tracked work. Ordinary shell background children launched with `&` or `nohup` remain captured in that same supervised process group after the shell exits, so their logs and stop controls continue to work until the group ends. Deliberate new-session daemonization is not contained or adopted, and no process readiness is inferred. The integration fails closed when supervision or a supported adapter is unavailable. Third-party extensions and MCP tools are not intercepted, and support is limited to configured native adapters; this is process supervision, not an OS sandbox.

Starts are local-only. For status, output, and stop, `--node` uses the authenticated loopback app relay to reach that explicit cluster node. When the relay is configured, local `status` without an ID also uses it for the conversation-scoped, filtered listing and fails without falling back to the unfiltered supervisor list. Legacy environments without a configured relay retain direct-list compatibility. Local operations for a known ID continue over the stable supervisor socket, so status, output, and stop remain available while the app is down. The relay is restricted to the token's project and conversation, never falls back to another node, cannot launch tasks, and does not retry automatically. This is CLI support for the Linux and macOS native services. Shell syntax requires an explicit `sh -lc`. Ordinary app upgrades preserve supervisor-owned tasks, but native-service restart or reboot can interrupt them. Unknown tasks are not automatically replayed; uncertain starts should be retried only with the same UUID.

Terminal task receipts are durably copied into the app's node-local outbox. A deterministic system prompt is queued in the original logical conversation on its current owning node, including across app downtime and cluster routing. The existing shared queue and dispatcher perform the turn without requiring a browser client; busy, locked, deleted, unsupported, or unavailable conversations remain pending or blocked rather than being taken over. These internal completion turns are hidden from the live, queued, and reloaded conversation UI while remaining in native harness context. Queue insertion is idempotent across retries and consumed tombstones.

The automatic prompt contains only the trusted task ID, source node ID, and terminal status. It directs the agent to inspect output when needed and treats that output as untrusted; logs and errors are never embedded automatically. An `unknown` completion records interrupted or unobserved execution and commands are never replayed. A system prompt whose harness start is uncertain remains fenced in `starting` and is not automatically retried. Delivery may be delayed, so agents must not guarantee that a user receives a reply before queue processing completes. Nodes without an initialized supervisor report the capability unavailable and do not fall back to harness-native backgrounding.

## Conversation task history

Open a saved conversation and choose **Tasks** in its toolbar to inspect background work without typing a command. The listing is scoped to that logical conversation/session and clears when navigating to another conversation. The badge counts visible active tasks; the dialog shows the owning node, process status, bounded live output, terminal history, and node outages. A node marked unavailable is different from a conversation with no tasks. Stop always asks for confirmation and is sent to the task's owning node.

Process state and follow-up delivery are separate. “Follow-up pending”, “queued”, “blocked”, “start uncertain”, and “dispatched” describe delivery only; dispatched means the prompt was started or cancelled, not that a reply finished. An ordinary app restart preserves supervisor-owned work. A native-service restart or reboot can leave work `unknown`, as described above.

Manual acceptance: open a saved conversation, start a harmless long-running task through an agent, open **Tasks**, verify its node and streaming output, then Stop it and confirm the terminal and follow-up states independently. Repeat at a narrow mobile viewport, reload to verify history, and verify an unavailable node is called out rather than shown as an empty history.

Platform-neutral fake-service integration tests exercise the real installer and supervisor on the current test host. They do not claim that a live Linux or macOS native service was tested or that production deployment occurred.
