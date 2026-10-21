import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeMcpAuth, McpAuthError } from "../src/harnesses/claude/mcp-auth.ts";

// A stand-in for `claude -p --input-format stream-json` that speaks the MCP control requests.
// "remote" needs a token (a file here); "slow" reports pending on its first status; the token
// arrives either through a pasted callback URL or, like the CLI's localhost listener, by the
// test writing the file while the flow is open.
const FAKE_CLAUDE = `
const fs = require("node:fs");
const dir = process.argv[2];
const token = dir + "/token";
const log = (entry) => fs.appendFileSync(dir + "/requests.log", JSON.stringify(entry) + "\\n");
let statusCalls = 0;
let buffer = "";
const reply = (id, response) => process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response } }) + "\\n");
const fail = (id, error) => process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: id, error } }) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    const { request_id: id, request } = JSON.parse(line);
    log({ subtype: request.subtype, serverName: request.serverName, cwd: process.cwd() });
    if (request.subtype === "initialize") reply(id, {});
    else if (request.subtype === "mcp_status") {
      statusCalls++;
      reply(id, { mcpServers: [
        { name: "remote", status: fs.existsSync(token) ? "connected" : "needs-auth" },
        { name: "slow", status: statusCalls === 1 ? "pending" : "connected" },
        { name: "broken", status: "failed", error: "connection refused" },
      ] });
    } else if (request.subtype === "mcp_authenticate") {
      if (request.serverName === "slow") reply(id, { requiresUserAction: false });
      else reply(id, { authUrl: "https://auth.example/authorize?state=s1", requiresUserAction: true, callbackExpected: true, redirectScheme: "localhost", callbackPort: 4321 });
    } else if (request.subtype === "mcp_oauth_callback_url") {
      if (/code=good/.test(request.callbackUrl) && /state=s1/.test(request.callbackUrl)) { fs.writeFileSync(token, "t"); reply(id, {}); }
      else fail(id, "Callback URL not accepted: OAuth state mismatch");
    } else if (request.subtype === "mcp_reconnect") reply(id, {});
    else if (request.subtype === "mcp_clear_auth") { fs.rmSync(token, { force: true }); reply(id, {}); }
    else fail(id, request.subtype + " is not supported");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-mcp-auth-"));
  const script = path.join(root, "fake-claude.cjs");
  await writeFile(script, FAKE_CLAUDE);
  const spawned: Array<{ cwd: string; projectId?: string }> = [];
  const auth = createClaudeMcpAuth((cwd, projectId) => {
    spawned.push({ cwd, projectId });
    return spawn(process.execPath, [script, root], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  }, { settleMs: 5_000 });
  const requests = async () => (await readFile(path.join(root, "requests.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { subtype: string; serverName?: string; cwd: string });
  return { root, auth, spawned, requests };
}

test("status waits for connecting servers and reports each server's sign-in state", async () => {
  const { root, auth, spawned } = await fixture();
  try {
    const servers = await auth.status({ cwd: root, projectId: "p1", ownerKey: "alice" });
    assert.deepEqual(servers, [
      { name: "remote", status: "needs-auth" },
      { name: "slow", status: "connected" },
      { name: "broken", status: "failed", error: "connection refused" },
    ]);
    assert.deepEqual(spawned, [{ cwd: root, projectId: "p1" }], "the control process starts where the project's turns start");
    assert.equal(auth.openFlows(), 0, "a status check leaves nothing running");
  } finally { auth.closeAll(); await rm(root, { recursive: true, force: true }); }
});

test("a pasted redirect URL completes sign-in, and only for the person who started it", async () => {
  const { root, auth, requests } = await fixture();
  const alice = { cwd: root, ownerKey: "alice" };
  try {
    const started = await auth.start(alice, "remote");
    assert.equal(started.authUrl, "https://auth.example/authorize?state=s1");
    assert.equal(started.callbackPort, 4321);
    assert.equal(auth.openFlows(), 1);

    await assert.rejects(auth.finish(started.flowId, "bob", "http://localhost:4321/callback?code=good&state=s1"), (error: unknown) => error instanceof McpAuthError && error.statusCode === 404, "another person cannot finish it");
    await assert.rejects(auth.finish(started.flowId, "alice", "http://localhost:4321/callback?code=bad&state=other"), /state mismatch/);
    assert.equal(auth.openFlows(), 1, "a wrong paste leaves the sign-in open for another try");
    assert.deepEqual(await auth.finish(started.flowId, "alice"), { name: "remote", status: "needs-auth" }, "Done before the browser step finished reports it, and keeps the flow");
    assert.equal(auth.openFlows(), 1);

    assert.deepEqual(await auth.finish(started.flowId, "alice", "http://localhost:4321/callback?code=good&state=s1"), { name: "remote", status: "connected" });
    assert.equal(auth.openFlows(), 0, "a finished sign-in closes its process");
    const sent = (await requests()).map((entry) => entry.subtype);
    assert.ok(sent.includes("mcp_authenticate") && sent.includes("mcp_oauth_callback_url") && sent.includes("mcp_reconnect"));
  } finally { auth.closeAll(); await rm(root, { recursive: true, force: true }); }
});

test("sign-in finished by the node's own listener needs no paste; sign-out clears it", async () => {
  const { root, auth, requests } = await fixture();
  const alice = { cwd: root, ownerKey: "alice" };
  try {
    const started = await auth.start(alice, "remote");
    await writeFile(path.join(root, "token"), "t"); // the browser reached the CLI's localhost listener
    assert.deepEqual(await auth.finish(started.flowId, "alice"), { name: "remote", status: "connected" });

    await auth.signOut(alice, "remote");
    assert.equal(existsSync(path.join(root, "token")), false);
    assert.ok((await requests()).some((entry) => entry.subtype === "mcp_clear_auth" && entry.serverName === "remote"));
    assert.deepEqual((await auth.status(alice)).find((server) => server.name === "remote"), { name: "remote", status: "needs-auth" });
  } finally { auth.closeAll(); await rm(root, { recursive: true, force: true }); }
});

test("unknown servers are refused, a silent sign-in opens no flow, and a restart replaces the abandoned one", async () => {
  const { root, auth } = await fixture();
  const alice = { cwd: root, ownerKey: "alice" };
  try {
    await assert.rejects(auth.start(alice, "elsewhere"), /does not load an MCP server named elsewhere/);
    assert.equal(auth.openFlows(), 0);
    const silent = await auth.start(alice, "slow");
    assert.equal(silent.authUrl, undefined);
    assert.equal(auth.openFlows(), 0);

    const first = await auth.start(alice, "remote");
    const second = await auth.start(alice, "remote");
    assert.equal(auth.openFlows(), 1, "starting again ends the earlier attempt");
    await assert.rejects(auth.finish(first.flowId, "alice"), /sign-in has ended/);
    await assert.rejects(Promise.resolve().then(() => auth.cancel(second.flowId, "bob")), /sign-in has ended/, "another person cannot cancel it");
    auth.cancel(second.flowId, "alice");
    assert.equal(auth.openFlows(), 0);
  } finally { auth.closeAll(); await rm(root, { recursive: true, force: true }); }
});

test("a sign-in left waiting is closed after its timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-mcp-auth-"));
  const script = path.join(root, "fake-claude.cjs");
  await writeFile(script, FAKE_CLAUDE);
  const auth = createClaudeMcpAuth((cwd) => spawn(process.execPath, [script, root], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams, { settleMs: 5_000, flowTimeoutMs: 200 });
  try {
    const started = await auth.start({ cwd: root, ownerKey: "alice" }, "remote");
    assert.equal(auth.openFlows(), 1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(auth.openFlows(), 0);
    await assert.rejects(auth.finish(started.flowId, "alice"), /sign-in has ended/);
  } finally { auth.closeAll(); await rm(root, { recursive: true, force: true }); }
});
