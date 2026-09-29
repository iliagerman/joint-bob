# Subprocess maximum lifetime

`subprocessMaxLifetimeMinutes` is a node-local Settings GET/PUT field, persisted in
`node_settings`. Default 360, integer range 1 through 10080. Omission preserves the
saved value. Null, strings, fractions and out-of-range numbers are rejected.
Settings > Shell commands exposes the same field. Watchers share a short-lived policy
cache and process-table snapshot, bounding steady-state monitoring to a few node-wide
reads per second instead of one database open and `ps` scan per owned process.

Each registered process keeps its original launch time. Output, input and settings
changes do not reset it. A watcher rereads persisted policy while running, normally
once per second. Lowering the limit below elapsed time starts termination on the
next check, normally within two seconds. Raising it extends a process that has not yet begun termination.
Termination sends SIGTERM, then SIGKILL after five seconds. Once termination starts,
raising the setting does not undo it. Existing shorter command timeouts still win.
Only the separate shell-command timeout promises exit code 124; lifetime expiration
produces the process's signal/exit result and supervised tasks become stopped.

## Launch inventory

- `src/subprocess.ts` registers native spawn/execFile results. Used by Claude CLI,
  Kiro ACP, harness probes and upgrades, queued preflight, Git/worktree commands and
  the server's command helper. Native execFile timeout and promise semantics remain.
- `src/terminal-session.ts` registers each new PTY shell. Expiration follows normal
  terminal exit handling and closes its socket. It never targets another terminal.
- `scripts/joint-bob-supervisor.mjs` registers task workers only. This covers explicit
  background jobs and Pi/Claude/Kiro shell commands routed through the existing
  supervised-shell shim, including background children that remain observable.
  The supervisor reads policy itself, so enforcement survives app replacement.
- Pi's agent SDK executes in the server process. There is no Pi agent process to
  expire. Its integrated shell is covered through the supervisor, not by terminating
  the server.

The shared implementation is `scripts/subprocess-lifetime.mjs`, with declarations
in the adjacent `.d.mts`. It is also a supervisor compatibility component. Updating
an installed supervisor requires the existing maintenance-update path. Editing the
checkout does not change an already running release or its supervisor.

## Ownership and limits

Registration accepts a freshly launched child, never a persisted PID, process name,
age-based machine-wide match, or a server/supervisor ancestor. Process-table reads
only establish descendants of registered roots and already verified descendants.
Signals target individual owned PIDs, not an unverified old process-group number.
Before each descendant signal, the watcher rechecks UID and process birth identity.
Linux uses `/proc` start ticks; macOS uses `ps` start time. A replacement with a
changed identity is dropped. Root signalling also checks its original child handle.
Exit clears the watch when no known live descendants remain; known descendants are
terminated after root exit. Failed launches and completed watches release timers.
Observation failure sends no unverified signals and retries at the next interval.

This is **best-effort tree supervision**, not an OS containment boundary. A child
that detaches/reparents before observation can escape discovery. In particular,
short-lived roots can disappear before their first snapshot. UID/start-time checks
reduce PID reuse risk but are not atomic kernel process handles; macOS start times
have one-second precision and a check-to-signal race remains. Do not treat this as
a hard guarantee that every daemonized descendant is captured, or as adversarial
process isolation. The existing anchored supervisor process-group stop mechanism and update shutdown
remain separate mechanisms.

Deliberate exclusions:

- Joint Bob server, supervisor, and supervisor app worker. No lifetime timer targets
  them, so a six-hour deadline cannot trigger a server restart loop.
- Joint Bob's update installer in `src/updater.ts`, release/install scripts, service
  launchers and Syncthing infrastructure. Stopping an installer mid-switch is unsafe.
  Standalone development/build/release scripts are not application workload launches.
- Persistent Playwright browser contexts in `src/browser-runtime.ts`. Their existing
  browser lifecycle/idle controls remain; a hard cap would interrupt shared profiles.
- Arbitrary Pi SDK/third-party extension processes launched directly inside the
  server rather than through the task CLI. The registered root tree covers children
  of Claude/Kiro processes only while those children remain observable.
- Processes launched before this implementation was loaded, including an already
  running older installed supervisor. No PID adoption or machine-wide cleanup occurs.

An agent launching its own browser or other program inside a registered task does
not gain an infrastructure exemption. Its observable descendants remain in scope.

## Focused verification

Run through the isolated test harness:

```sh
npm run test:file -- test/subprocess-lifetime.test.ts test/subprocess-lifetime-settings.test.ts test/subprocess-lifetime-supervisor.test.ts test/subprocess-lifetime-terminal.test.ts
npm run test:file -- test/ui/ui-subprocess-lifetime.test.ts
npm run typecheck
```

Runtime tests inject millisecond limits rather than waiting six hours. They cover
TERM/KILL, ongoing output, changed deadlines, normal exit, observed descendants,
spawn failure, PID identity replacement and supervisor/app separation. API tests
cover defaults, bounds and persistence through server restart. The browser test
uses a disposable profile and verifies editing and reloading the Settings field.
A real test-owned PTY verifies lifetime expiration and terminal socket closure.

## Files changed for this feature

Runtime and policy:

- `scripts/subprocess-lifetime.mjs`
- `scripts/subprocess-lifetime.d.mts`
- `scripts/joint-bob-supervisor.mjs`
- `scripts/supervisor-release.mjs`
- `scripts/supervised-shell.mjs`, timeout comment only
- `src/subprocess.ts`
- `src/settings.ts`
- `src/server/schemas.ts`
- `src/terminal-session.ts`
- `src/claude-service.ts`
- `src/harnesses/claude/runtime.ts`
- `src/harnesses/kiro/runtime.ts`
- `src/harness-updater.ts`
- `src/queued-preflight.ts`
- `src/git-review.ts`
- `src/worktrees.ts`
- `src/server/state.ts`
- `src/agent-capabilities.ts`, timeout instructions only

Settings UI and documentation:

- `public/index.html`
- `public/app/elements.js`
- `public/app/settings.js`
- `public/sw.js`, cache version only
- `README.md`
- `docs/subprocess-lifetime.md`

Tests:

- `test/subprocess-lifetime.test.ts`
- `test/subprocess-lifetime-settings.test.ts`
- `test/subprocess-lifetime-supervisor.test.ts`
- `test/subprocess-lifetime-terminal.test.ts`
- `test/ui/ui-subprocess-lifetime.test.ts`
- `test/settings-api.test.ts`, expected response field
- `test/supervisor-install.test.ts`, component fixture list
- `test/supervisor-control-timeout.test.ts`, component fixture list
