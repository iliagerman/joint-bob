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
node "$JOINT_BOB_TASK_CLI" status [id]
node "$JOINT_BOB_TASK_CLI" output id [--offset N] [--limit N]
node "$JOINT_BOB_TASK_CLI" stop id
```

This is local CLI support for the Linux and macOS native services. Shell syntax requires an explicit `sh -lc`. Ordinary app upgrades preserve supervisor-owned tasks, but native-service restart or reboot can interrupt them. Unknown tasks are not automatically replayed; uncertain starts should be retried only with the same UUID.

There is currently no task UI, headless completion notification, automatic conversation wakeup, or cluster output routing. Agents must use `status` and `output` and must not promise a later autonomous reply. Nodes without an initialized, running supervisor report the capability unavailable and do not fall back to harness-native backgrounding.

Platform-neutral fake-service integration tests exercise the real installer and supervisor on the current test host. They do not claim that a live Linux or macOS native service was tested or that production deployment occurred.
