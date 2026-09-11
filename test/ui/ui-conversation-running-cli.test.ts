import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

const exec = promisify(execFile);
async function browser(...args: string[]): Promise<unknown> {
  const cli = process.env.JOINT_BOB_BROWSER_CLI;
  assert.ok(cli, "Designated browser executor required; no local fallback");
  const { stdout } = await exec(process.execPath, [cli, ...args], { timeout: 30_000 });
  return (JSON.parse(stdout) as { result?: unknown }).result;
}
async function waitFor(expression: string): Promise<void> {
  assert.equal(await browser("evaluate", `(async () => {
    const deadline = Date.now() + 8000;
    while (!(${expression})) {
      if (Date.now() > deadline) throw Error(${JSON.stringify(`Timed out: ${expression}`)});
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return true;
  })()`), true);
}

test("peer-reported running conversation returns to review without a dashboard or another socket event", { timeout: 120_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "joint-bob-running-ui-")));
  const environment = await seedDevEnvironment(root, 1);
  const server = await startDevNode(environment, environment.nodes[0]);
  try {
    await browser("start");
    await browser("navigate", environment.nodes[0].url);
    await waitFor('document.querySelector("#loginDialog").open');
    await browser("fill", "#loginUsernameInput", environment.username);
    await browser("fill", "#loginPasswordInput", environment.password);
    await browser("click", "#loginSubmitButton");
    await waitFor('document.querySelectorAll("#projectList .list-row").length === 3');
    await browser("evaluate", '[...document.querySelectorAll("#projectList .list-row")].find(row => row.textContent.includes("Internal Assistant")).querySelector("button").click()');
    await browser("click", '[data-filter="all"]');
    await waitFor('[...document.querySelectorAll("#sessionList .list-row")].some(row => row.textContent.includes("Short one"))');
    assert.equal(await browser("evaluate", `(async () => {
      const { state } = await import('/app/state.js');
      const { closeWatchSocket, closeSocket, refreshSessionsQuietly } = await import('/app/socket.js');
      closeWatchSocket(); closeSocket();
      while (state.sessionsRefreshing) await new Promise(resolve => setTimeout(resolve, 20));
      const id = state.sessions.find(session => session.title === 'Short one').id;
      const endpoint = '/api/projects/' + encodeURIComponent(state.activeProjectId) + '/sessions';
      const originalFetch = window.fetch;
      window.__runningPollTest = { running: true, requests: 0 };
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (new URL(String(args[0]), location.href).pathname !== endpoint) return response;
        const body = await response.json();
        window.__runningPollTest.requests++;
        for (const session of body.sessions) {
          delete session.agentRuns;
          session.running = session.id === id && window.__runningPollTest.running;
          session.reviewState = session.running ? 'running' : 'needs_review';
        }
        return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
      };
      await refreshSessionsQuietly();
      if (!state.sessions.find(session => session.id === id).running) throw Error('Running precondition missing');
      if (state.sessions.some(session => session.agentRuns?.length)) throw Error('Test must not have dashboard records');
      return true;
    })()`), true);
    await waitFor('[...document.querySelectorAll("#sessionList .list-row")].find(row => row.textContent.includes("Short one"))?.querySelector(".chat-badge b").textContent === "Running"');
    await browser("evaluate", 'window.__runningPollTest.running = false');
    await waitFor('[...document.querySelectorAll("#sessionList .list-row")].find(row => row.textContent.includes("Short one"))?.querySelector(".chat-badge b").textContent === "Needs review"');
    assert.equal(await browser("evaluate", `(async () => {
      const { state } = await import('/app/state.js');
      return window.__runningPollTest.requests >= 2 && state.agentRunPollTimer === null;
    })()`), true, "completion is polled and polling stops when all conversations are idle");
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
