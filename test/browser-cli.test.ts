import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

const cli = path.resolve("bin/joint-bob-browser.mjs");
const token = "fixture-browser-token";
const secret = "fixture-password-\"\\\n-do-not-print";
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cli-"));
  const requests: Array<Record<string, any>> = [];
  let response: (body: any) => { status?: number; body: unknown; raw?: boolean } = () => ({ body: { result: { ok: true } } });
  const server = createServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/browser/agent");
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const result = response(body);
    res.writeHead(result.status ?? 200, { "content-type": result.raw ? "application/octet-stream" : "application/json" });
    res.end(result.raw ? result.body : JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return {
    root, requests,
    respond(handler: typeof response) { response = handler; },
    run(args: string[], env: NodeJS.ProcessEnv = {}) {
      return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, JOINT_BOB_BROWSER_URL: `http://127.0.0.1:${address.port}/api/browser/agent`, JOINT_BOB_BROWSER_TOKEN: token, FIXTURE_PASSWORD: secret, ...env }, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    },
  };
}

const session = { id: "s", state: "running", owner: "agent", activePageId: "page", tabs: [{ id: "page", url: "https://login.example/form", title: "Login" }] };

test("CLI maps explicit start and browser commands without caller-selected identity", async (t) => {
  const f = await fixture(t);
  const cases: Array<[string[], unknown]> = [
    [["start", "https://example.com", "--profile", "profile"], { operation: "start", url: "https://example.com", profileId: "profile" }],
    [["start"], { operation: "start" }],
    [["status"], { operation: "status" }],
    [["profiles"], { operation: "profiles" }],
    [["snapshot"], { operation: "command", command: { action: "snapshot" } }],
    [["click", "#submit"], { operation: "command", command: { action: "clickElement", selector: "#submit" } }],
    [["fill", "#name", "Alice"], { operation: "command", command: { action: "fill", selector: "#name", text: "Alice" } }],
    [["navigate", "https://example.com"], { operation: "command", command: { action: "navigate", url: "https://example.com" } }],
    [["evaluate", "document.title"], { operation: "command", command: { action: "evaluate", expression: "document.title" } }],
    [["save-login", "Work login"], { operation: "command", command: { action: "saveProfile", label: "Work login" } }],
    [["command", '{"action":"key","key":"Enter"}'], { operation: "command", command: { action: "key", key: "Enter" } }],
    [["close"], { operation: "command", command: { action: "close" } }],
  ];
  for (const [args, expected] of cases) {
    const result = await f.run(args);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(f.requests.at(-1), expected);
    assert.deepEqual(JSON.parse(result.stdout), { result: { ok: true } });
  }
  f.respond(() => ({ body: { sessions: [session] } }));
  const tabs = await f.run(["tabs"]);
  assert.equal(tabs.code, 0, tabs.stderr);
  assert.deepEqual(JSON.parse(tabs.stdout), { tabs: session.tabs, activePageId: "page" });
  assert.deepEqual(f.requests.at(-1), { operation: "status" });
});

test("CLI binds each account operation to its explicit profile", async (t) => {
  const f = await fixture(t);
  const cases: Array<[string[], unknown]> = [
    [["start", "https://web.whatsapp.com", "--name", "WhatsApp personal"], { operation: "start", url: "https://web.whatsapp.com", profileName: "WhatsApp personal" }],
    [["click", "#message", "--profile", "work"], { operation: "command", profileId: "work", command: { action: "clickElement", selector: "#message" } }],
    [["evaluate", "--profile", "personal", "document.title"], { operation: "command", profileId: "personal", command: { action: "evaluate", expression: "document.title" } }],
    [["close", "--profile", "work"], { operation: "command", profileId: "work", command: { action: "close" } }],
    [["fill", "--profile", "work", "--", "#text", "--profile"], { operation: "command", profileId: "work", command: { action: "fill", selector: "#text", text: "--profile" } }],
  ];
  for (const [args, expected] of cases) {
    const result = await f.run(args);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(f.requests.at(-1), expected);
  }
  const personal = { ...session, id: "personal-session", profileId: "personal" };
  const work = { ...session, id: "work-session", profileId: "work", tabs: [{ id: "page", url: "https://work.example", title: "Work" }] };
  f.respond(body => body.operation === "status" ? { body: { sessions: [personal, work] } } : { body: { result: { ok: true } } });
  assert.notEqual((await f.run(["tabs"])).code, 0, "Never guess an account when several are running");
  const tabs = await f.run(["tabs", "--profile", "work"]);
  assert.equal(tabs.code, 0, tabs.stderr);
  assert.deepEqual(JSON.parse(tabs.stdout).tabs, work.tabs);
  const filled = await f.run(["fill-secret", "#password", "FIXTURE_PASSWORD", "--origin", "https://login.example", "--profile", "personal"]);
  assert.equal(filled.code, 0, filled.stderr);
  assert.equal(f.requests.at(-1)!.profileId, "personal");
  const count = f.requests.length;
  for (const args of [["start", "--name", "New", "--profile", "work"], ["start", "--name", " "], ["click", "#x", "--profile"], ["start", "--name", "x".repeat(81)]]) {
    assert.notEqual((await f.run(args)).code, 0);
  }
  assert.equal(f.requests.length, count, "Invalid profile options must fail before a request");
});

test("CLI refuses to infer an account from incomplete cross-node discovery", async t => {
  const f = await fixture(t);
  f.respond(body => body.operation === "status" ? { body: {
    sessions: [{ ...session, profileId: "personal" }],
    unavailableNodes: [{ nodeId: "offline-node", reason: "Browser node is unreachable" }],
  } } : { body: { result: { ok: true } } });
  for (const args of [["tabs"], ["fill-secret", "#password", "FIXTURE_PASSWORD", "--origin", "https://login.example"]]) {
    const result = await f.run(args);
    assert.notEqual(result.code, 0, "Partial discovery cannot prove this is the only account");
    assert.match(result.stderr, /discovery incomplete/i);
    assert.equal(f.requests.at(-1)!.operation, "status", "Never send a secret to an inferred account");
  }
  const explicit = await f.run(["tabs", "--profile", "personal"]);
  assert.equal(explicit.code, 0, explicit.stderr);
});

test("CLI start selects a browser machine without retargeting account commands", async t => {
  const f = await fixture(t);
  const nodeId = "11111111-1111-4111-8111-111111111111";
  const result = await f.run(["start", "https://web.whatsapp.com", "--node", nodeId, "--name", "Personal WhatsApp"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.requests.at(-1), { operation: "start", url: "https://web.whatsapp.com", nodeId, profileName: "Personal WhatsApp" });
  const reopened = await f.run(["start", "--profile", "personal", "--node", nodeId]);
  assert.equal(reopened.code, 0, reopened.stderr);
  assert.deepEqual(f.requests.at(-1), { operation: "start", profileId: "personal", nodeId });
  const count = f.requests.length;
  for (const args of [["start", "--node", ""], ["start", "--node", "homeserver"], ["start", "--node"], ["status", "--node", nodeId], ["close", "--node", nodeId], ["click", "#send", "--node", nodeId]]) {
    assert.notEqual((await f.run(args)).code, 0, `Reject invalid or unsafe node override: ${args.join(" ")}`);
  }
  assert.equal(f.requests.length, count, "Reject before any server mutation");
});

test("CLI errors are useful, nonzero, bounded and redact authentication", async (t) => {
  const f = await fixture(t);
  for (const args of [[], ["wat"], ["fill", "#name"], ["command", "{"], ["command", "null"], ["screenshot"], ["start", "--profile"], ["status", "extra"]]) {
    assert.notEqual((await f.run(args)).code, 0);
  }
  assert.equal(f.requests.length, 0);
  const missing = await f.run(["status"], { JOINT_BOB_BROWSER_TOKEN: "" });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /environment|token|conversation/i);
  for (const error of ["No browser executable available", "Local browser unavailable", "Manual takeover pauses agent commands", "No running browser; use start first"]) {
    f.respond(() => ({ status: 409, body: { error: `${error}: ${token}` } }));
    const result = await f.run(["snapshot"]);
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes(error));
    assert.ok(!result.stderr.includes(token));
  }
  f.respond(() => ({ body: { result: "x".repeat(100_000) + token } }));
  const big = await f.run(["snapshot"]);
  assert.equal(big.code, 0);
  assert.ok(big.stdout.length <= 40_000);
  assert.equal(JSON.parse(big.stdout).truncated, true);
  assert.ok(!big.stdout.includes(token));
  f.respond(() => ({ body: "not-json", raw: true }));
  const malformed = await f.run(["status"]);
  assert.notEqual(malformed.code, 0);
  assert.match(malformed.stderr, /JSON|response/i);
  const offline = await f.run(["status"], { JOINT_BOB_BROWSER_URL: "http://127.0.0.1:1/api/browser/agent" });
  assert.notEqual(offline.code, 0);
  assert.match(offline.stderr, /unreachable|connect|offline/i);
  assert.match(offline.stderr, /local Joint Bob service/);
  assert.doesNotMatch(offline.stderr, /designated executor|fallback/i);
});

test("fill-secret verifies active origin, refuses takeover/missing browser, and never prints secret responses", async (t) => {
  const f = await fixture(t);
  const args = ["fill-secret", "#password", "FIXTURE_PASSWORD", "--origin", "https://login.example"];
  for (const sessions of [[], [{ ...session, owner: "human" }], [{ ...session, tabs: [{ id: "page", url: "https://login.example.evil/form" }] }], [{ ...session, tabs: [{ id: "page", url: "http://login.example/form" }] }]]) {
    f.respond(() => ({ body: { sessions } }));
    const result = await f.run(args);
    assert.notEqual(result.code, 0);
    assert.equal(f.requests.at(-1)!.operation, "status");
    assert.ok(!result.stderr.includes(secret));
  }
  f.respond((body) => body.operation === "status" ? { body: { sessions: [session] } } : { body: { result: { echo: secret, token } } });
  const filled = await f.run(args);
  assert.equal(filled.code, 0, filled.stderr);
  assert.deepEqual(f.requests.at(-1), { operation: "command", command: { action: "fill", selector: "#password", text: secret, expectedOrigin: "https://login.example", expectedPageId: "page" } });
  assert.deepEqual(JSON.parse(filled.stdout), { ok: true });
  assert.ok(!filled.stdout.includes("fixture-password"));
  f.respond((body) => body.operation === "status" ? { body: { sessions: [session] } } : { status: 500, body: { error: secret } });
  const failed = await f.run(args);
  assert.notEqual(failed.code, 0);
  assert.ok(!failed.stderr.includes("fixture-password"));
  const count = f.requests.length;
  assert.notEqual((await f.run(args, { FIXTURE_PASSWORD: undefined })).code, 0);
  assert.equal(f.requests.length, count);
  assert.notEqual((await f.run(["fill-secret", "#password", "FIXTURE_PASSWORD"])).code, 0);
});

test("fill-secret cannot follow a replacement account at the same origin", async t => {
  const f = await fixture(t);
  const original = { ...session, profileId: "personal", activePageId: "personal-page", tabs: [{ id: "personal-page", url: "https://login.example/form", title: "Personal" }] };
  f.respond(body => {
    if (body.operation === "status") return { body: { sessions: [original] } };
    // Personal ended after status; Work is now the sole account at the same origin.
    return body.profileId === "personal"
      ? { status: 404, body: { error: "Original profile is no longer running" } }
      : { body: { result: { target: "work" } } };
  });
  const result = await f.run(["fill-secret", "#password", "FIXTURE_PASSWORD", "--origin", "https://login.example"]);
  assert.notEqual(result.code, 0, "Never fill the replacement account merely because its origin matches");
  assert.equal(f.requests.at(-1)!.profileId, "personal");
  assert.equal(f.requests.at(-1)!.command.expectedPageId, "personal-page");
  assert.ok(!result.stderr.includes("fixture-password"));
});

test("CLI uploads files and directories as base64 and rejects cumulative oversize before sending", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "one.txt"), "hello");
  await mkdir(path.join(f.root, "folder"));
  await writeFile(path.join(f.root, "folder", "two.bin"), Buffer.from([0, 1, 255]));
  const result = await f.run(["upload", "#files", path.join(f.root, "one.txt"), path.join(f.root, "folder")]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.requests.at(-1), { operation: "command", command: { action: "upload", selector: "#files", files: [
    { name: "one.txt", data: Buffer.from("hello").toString("base64") },
    { name: "folder/two.bin", data: Buffer.from([0, 1, 255]).toString("base64") },
  ] } });
  await writeFile(path.join(f.root, "large"), "");
  await truncate(path.join(f.root, "large"), 20 * 1024 * 1024);
  const before = f.requests.length;
  const tooBig = await f.run(["upload", "#files", path.join(f.root, "large"), path.join(f.root, "one.txt")]);
  assert.notEqual(tooBig.code, 0);
  assert.match(tooBig.stderr, /20 MiB/);
  assert.equal(f.requests.length, before);
  assert.notEqual((await f.run(["upload", "#files", path.join(f.root, "missing")])).code, 0);
});

test("CLI writes screenshot and raw downloads on agent node without dumping blobs", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
  f.respond((body) => body.operation === "download" ? { body: bytes, raw: true } : { body: { result: { data: bytes.toString("base64"), mimeType: "image/png" }, session } });
  for (const [args, name] of [[["screenshot"], "shot.png"], [["download", "download-id"], "download.bin"]] as const) {
    const output = path.join(f.root, "output", name);
    const result = await f.run([...args, output]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readFile(output), bytes);
    assert.equal(JSON.parse(result.stdout).path, output);
    assert.ok(!result.stdout.includes(bytes.toString("base64")));
  }
  assert.deepEqual(f.requests.at(-1), { operation: "download", downloadId: "download-id" });
  const generic = await f.run(["command", '{"action":"screenshot"}']);
  assert.notEqual(generic.code, 0);
  assert.match(generic.stderr, /screenshot PATH/);
});
