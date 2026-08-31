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
