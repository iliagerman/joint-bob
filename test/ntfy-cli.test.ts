import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cli = new URL("../bin/joint-bob-ntfy.mjs", import.meta.url).pathname;

test("ntfy CLI sends only the constrained request with its capability", async () => {
  let captured: { authorization?: string; body?: unknown } = {};
  const server = createServer((request, response) => { let body = ""; request.on("data", (part) => body += part); request.on("end", () => { captured = { authorization: request.headers.authorization, body: JSON.parse(body) }; response.setHeader("content-type", "application/json"); response.end('{"ok":true,"topic":"updates"}'); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address missing");
  try {
    const { stdout } = await execute(process.execPath, [cli, "send", "--topic", "updates", "--message", "done", "--title", "Ready", "--service", "00000000-0000-4000-8000-000000000001"], { env: { ...process.env, JOINT_BOB_NTFY_URL: `http://127.0.0.1:${address.port}`, JOINT_BOB_NTFY_TOKEN: "capability-secret" } });
    assert.deepEqual(JSON.parse(stdout), { ok: true, topic: "updates" });
    assert.deepEqual(captured, { authorization: "Bearer capability-secret", body: { operation: "send", topic: "updates", message: "done", title: "Ready", serviceId: "00000000-0000-4000-8000-000000000001" } });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("ntfy CLI rejects missing environment and does not print token", async () => {
  await assert.rejects(execute(process.execPath, [cli, "status"], { env: { ...process.env, JOINT_BOB_NTFY_URL: "", JOINT_BOB_NTFY_TOKEN: "do-not-print" } }), (error: unknown) => {
    const output = String((error as { stderr?: string }).stderr);
    assert.doesNotMatch(output, /do-not-print/);
    assert.match(output, /environment missing/i);
    return true;
  });
});

async function rejectingBridge(status: number, body: string, contentType = "text/plain") {
  let requests = 0;
  const server = createServer((_request, response) => { requests += 1; response.statusCode = status; response.setHeader("content-type", contentType); response.end(body); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address missing");
  return { server, url: `http://127.0.0.1:${address.port}`, requests: () => requests };
}

async function cliFailure(args: string[], url: string, token = "synthetic-capability-secret"): Promise<string> {
  try { await execute(process.execPath, [cli, ...args], { env: { ...process.env, JOINT_BOB_NTFY_URL: url, JOINT_BOB_NTFY_TOKEN: token } }); }
  catch (error) { return String((error as { stderr?: string }).stderr); }
  assert.fail("CLI unexpectedly succeeded");
}

test("ntfy CLI status prints only its safe projection", async () => {
  const fixture = await rejectingBridge(200, JSON.stringify({ services: [{ id: "id", name: "Name", url: "secret-url", hasToken: true }], defaultTopic: null, hasConversationTarget: false, secret: "hidden" }), "application/json");
  try {
    const { stdout } = await execute(process.execPath, [cli, "status"], { env: { ...process.env, JOINT_BOB_NTFY_URL: fixture.url, JOINT_BOB_NTFY_TOKEN: "token" } });
    assert.deepEqual(JSON.parse(stdout), { services: [{ id: "id", name: "Name" }], defaultTopic: null, hasConversationTarget: false });
    assert.doesNotMatch(stdout, /secret-url|hidden/);
  } finally { await new Promise<void>(resolve => fixture.server.close(() => resolve())); }
});

test("ntfy CLI rejects arguments before making a request", async () => {
  const fixture = await rejectingBridge(200, "{}");
  try {
    await cliFailure(["send", "--unknown", "x", "--message", "done"], fixture.url);
    await cliFailure(["send", "--topic", "x"], fixture.url);
    assert.equal(fixture.requests(), 0);
  } finally { await new Promise<void>(resolve => fixture.server.close(() => resolve())); }
});

test("ntfy CLI redacts JSON errors and never prints non-JSON bodies", async () => {
  const secret = "synthetic-capability-secret";
  const json = await rejectingBridge(400, JSON.stringify({ error: `bad ${secret}` }), "application/json");
  try { const output = await cliFailure(["status"], json.url, secret); assert.doesNotMatch(output, new RegExp(secret)); assert.match(output, /\[redacted\]/); }
  finally { await new Promise<void>(resolve => json.server.close(() => resolve())); }
  const text = await rejectingBridge(500, "never-print-this-body");
  try { assert.doesNotMatch(await cliFailure(["status"], text.url), /never-print-this-body/); }
  finally { await new Promise<void>(resolve => text.server.close(() => resolve())); }
});

test("ntfy CLI rejects malformed success and warns uncertain sends", async () => {
  for (const body of ["not-json", '{"ok":true}', '{"services":"wrong"}']) {
    const fixture = await rejectingBridge(200, body, "application/json");
    try { assert.match(await cliFailure(["send", "--message", "done"], fixture.url), /uncertain/i); }
    finally { await new Promise<void>(resolve => fixture.server.close(() => resolve())); }
  }
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address(); if (!address || typeof address === "string") throw new Error("probe address missing");
  await new Promise<void>(resolve => probe.close(() => resolve()));
  assert.match(await cliFailure(["send", "--message", "done"], `http://127.0.0.1:${address.port}`), /uncertain/i);
});
