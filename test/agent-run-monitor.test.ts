import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { agentRunDescriptor, refreshAgentRun } from "../src/agent-run-monitor.js";

const runId = "run-1";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return address.port;
}

test("multi-agent descriptors queue tool-result tasks and refresh dashboard state", async () => {
  let response: unknown = { runs: [{ runId, status: "running", tasks: [
    { id: "worker", role: "worker", agent: "default", status: "running" },
    { id: "reviewer", role: "reviewer", agent: "code-reviewer", status: "succeeded" },
    { id: "watcher", role: "watcher", agent: "default", status: "failed" },
  ] }] };
  const server = createServer((_request, reply) => { reply.setHeader("Content-Type", "application/json"); reply.end(JSON.stringify(response)); });
  try {
    const port = await listen(server);
    const event = { type: "tool_execution_end", toolName: "multi_agent_run", result: { details: { runId, dashboardUrl: `http://127.0.0.1:${port}/?key=secret`, tasks: [
      { id: "worker", role: "worker", agent: "default", task: "x" },
      { id: "reviewer", role: "reviewer", agent: "code-reviewer", task: "y" },
      { id: "watcher", role: "watcher", agent: "default", task: "z" },
    ] } } };
    const descriptor = agentRunDescriptor(event);
    assert.ok(descriptor);
    assert.equal(descriptor.stateUrl, `http://127.0.0.1:${port}/api/state`);
    assert.deepEqual(descriptor.summary.tasks.map((task) => task.status), ["queued", "queued", "queued"]);
    assert.deepEqual(await refreshAgentRun(descriptor), { runId, status: "running", tasks: [
      { name: "default", role: "worker", status: "running" },
      { name: "code-reviewer", role: "reviewer", status: "succeeded" },
      { name: "default", role: "watcher", status: "failed" },
    ] });
    assert.equal(agentRunDescriptor({ ...event, result: { details: { ...event.result.details, dashboardUrl: "http://example.com/?key=secret" } } }), undefined);
    assert.equal(agentRunDescriptor({ ...event, result: { details: { ...event.result.details, dashboardUrl: "not a URL" } } }), undefined);
    assert.equal(agentRunDescriptor({ type: "tool_execution_end", toolName: "multi_agent_run", result: { details: { runId, dashboardUrl: `http://127.0.0.1:${port}`, tasks: [{ role: 1, agent: "default" }] } } }), undefined);
    response = { runs: [] };
    await assert.rejects(refreshAgentRun(descriptor), /not found/);
    response = { runs: "bad" };
    await assert.rejects(refreshAgentRun(descriptor), /malformed/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("active agent runs refresh project sessions every two seconds", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /agentRunPollTimer: null/);
  assert.match(app, /function scheduleAgentRunPoll\(\)[\s\S]*clearTimeout\(state\.agentRunPollTimer\)[\s\S]*\["queued", "running"\]\.includes\(run\.status\)[\s\S]*setTimeout\([\s\S]*refreshSessionsQuietly\(\)[\s\S]*2000\)/);
  assert.match(app, /state\.sessionsRefreshing = false;\s*scheduleAgentRunPoll\(\);/);
});

test("a failed task carries its reason to the session list", async () => {
  // Verbatim shape of a real failed worker, captured from a live dashboard on 2026-09-01.
  const stderr = [
    "(node:60736) ExperimentalWarning: SQLite is an experimental feature and might change at any time",
    "(Use `node --trace-warnings ...` to show where the warning was created)",
    "node:events:497",
    "      throw er; // Unhandled 'error' event",
    "      ^",
    "",
    "Error: listen EADDRINUSE: address already in use 0.0.0.0:8790",
    "    at Server.setupListenHandle [as _listen2] (node:net:1941:16)",
  ].join("\n");
  const response = { runs: [{ id: runId, status: "failed", tasks: [
    { id: "worker", role: "worker", agent: "default", status: "failed", stderr, exitCode: 1 },
    { id: "quiet", role: "worker", agent: "default", status: "failed", stderr: "", exitCode: 137 },
    { id: "silent", role: "worker", agent: "default", status: "failed", stderr: "" },
    { id: "watcher", role: "watcher", agent: "default", status: "succeeded", stderr: "noise on a task that passed" },
  ] }] };
  const server = createServer((_request, reply) => { reply.setHeader("Content-Type", "application/json"); reply.end(JSON.stringify(response)); });
  try {
    const port = await listen(server);
    const descriptor = agentRunDescriptor({ type: "tool_execution_end", toolName: "multi_agent_run", result: { details: {
      runId, dashboardUrl: `http://127.0.0.1:${port}/?key=secret`, tasks: [{ id: "worker", role: "worker", agent: "default" }],
    } } });
    assert.ok(descriptor);
    const summary = await refreshAgentRun(descriptor);

    // Node's warning banner is dropped so the first visible line is the actual throw.
    assert.match(summary.tasks[0].error ?? "", /^Error: listen EADDRINUSE: address already in use 0\.0\.0\.0:8790\n {4}at Server\./);
    // A worker killed without output still says something actionable.
    assert.equal(summary.tasks[1].error, "Worker exited with code 137");
    assert.equal(summary.tasks[2].error, undefined);
    // A task that finished has nothing to explain.
    assert.equal(summary.tasks[3].error, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a stack trace is capped before it reaches every session list payload", async () => {
  const response = { runs: [{ id: runId, status: "failed", tasks: [
    { id: "worker", role: "worker", agent: "default", status: "failed", stderr: `Error: boom\n${"    at frame\n".repeat(200)}` },
  ] }] };
  const server = createServer((_request, reply) => { reply.setHeader("Content-Type", "application/json"); reply.end(JSON.stringify(response)); });
  try {
    const port = await listen(server);
    const descriptor = agentRunDescriptor({ type: "tool_execution_end", toolName: "multi_agent_run", result: { details: {
      runId, dashboardUrl: `http://127.0.0.1:${port}/?key=secret`, tasks: [{ id: "worker", role: "worker", agent: "default" }],
    } } });
    assert.ok(descriptor);
    const summary = await refreshAgentRun(descriptor);
    assert.equal(summary.tasks[0].error?.length, 500);
    assert.match(summary.tasks[0].error ?? "", /^Error: boom\n/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the session list prints why a task failed", async () => {
  const [app, styles] = await Promise.all([readFile("public/app.js", "utf8"), readFile("public/styles.css", "utf8")]);

  // The reason renders inline: a phone has no hover, so a title attribute alone would hide it.
  assert.match(app, /agentRunTaskReason\(task\)/);
  assert.match(app, /function agentRunTaskReason\(task\) \{[\s\S]*task\.status !== "failed"[\s\S]*No reason reported/);
  assert.match(app, /dataset\.testid = "agent-run-task-reason"/);
  assert.match(styles, /\.agent-run-task-reason \{/);
});
