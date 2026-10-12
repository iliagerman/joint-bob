# Conversation CPU and memory limits

`conversationCpuLimitCores` and `conversationMemoryLimitGb` are node-local Settings
GET/PUT fields, persisted in `node_settings`. Both default to `null`, which means no
limit. CPU accepts 0.1 through 1024 cores, memory 0.1 through 4096 GB; fractions are
allowed. Omission preserves the saved value and `null` removes a limit. Strings and
out-of-range numbers are rejected. **Settings > Shell commands** exposes both.

A limit applies to one conversation on this node: everything its shell commands and
background tasks start, added together. Each conversation is counted on its own, so
five conversations with a 2-core limit can use ten cores between them. Other nodes
keep their own limits.

## What happens at a limit

**CPU.** Once a second the supervisor measures the CPU time the conversation's
processes used. Above the limit it pauses them for part of every 200 ms slice
(`SIGSTOP`, then `SIGCONT`), sized so their average comes down to the limit. The
commands run slower and do not fail, although a test with a tight wall-clock timeout
can. A held conversation always keeps 5% of the time, so a limit far below its demand
is exceeded by that floor. The pausing stops within a second of the demand dropping.

**Memory.** The supervisor adds up the resident memory of the conversation's
processes. Above the limit for three readings in a row (three seconds), it stops the
conversation's largest command: TERM, then KILL after five seconds. The task ends
`stopped`, its `error` carries the reason, and the same line is appended to its
output, for example:

```text
Joint Bob stopped this command: its conversation was using 9.4 GB of memory, over the 8 GB limit for one conversation (Settings > Shell commands).
```

Changing a limit reaches running work within two seconds. Removing it wakes anything
that was paused.

## What is and is not limited

Limited: supervisor tasks, which covers explicit background jobs and the Pi, Claude
and Kiro shell commands routed through the supervised-shell shim, with the descendants
the lifetime watch has verified (see [subprocess-lifetime.md](subprocess-lifetime.md)).

Not limited:

- The agent process itself (the Claude or Kiro CLI, or the Pi SDK inside the server)
  and the MCP servers it starts directly. Pausing it would stall the turn.
- Each task's supervisor worker, which must stay awake to own its process group.
- Terminal shells, the server, the supervisor, Syncthing and browser sessions.

## Limits of the method

Neither macOS nor an unprivileged Linux user can cap a process tree in the kernel, so
this is **best-effort supervision by sampling**, not a container:

- A process that starts and exits between two readings is never counted.
- A child that detaches before it is observed escapes, as it does the lifetime limit.
- Memory is resident memory as `ps` reports it. Pages that processes share are counted
  once for each, so the total reads high. On macOS, memory the system has compressed
  or swapped out is not resident, so under memory pressure the total reads low.
- Pause signals go to PIDs verified against a process table at most half a second
  old. A PID reused inside that window could be paused for one slice; it is woken
  with the rest.
- Nothing stays paused when a limit is removed, a task ends, the limiter closes or
  the supervisor exits. A supervisor killed outright takes its task groups with it.

The limiter is `scripts/conversation-limits.mjs`, a supervisor compatibility
component: the supervisor reads the policy itself, so the limits hold while the app
is replaced. A release that changes it installs as a maintenance activation, which
restarts the supervisor and interrupts running tasks.

## Focused verification

```sh
npm run test:file -- test/conversation-limits.test.ts test/conversation-limits-settings.test.ts
npm run test:file -- test/ui/ui-conversation-limits.test.ts
npm run typecheck
```

The runtime tests drive the limiter over a made-up process table and clock, then
against a real busy loop, and through a real supervisor with a task that holds
300 MB. Measured on an M1 Max under load: four busy loops used 2.66 cores unlimited,
1.00 core under a 1-core limit, and 2.81 cores once it was removed.
