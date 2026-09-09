import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiRuntimeExtension } from "../src/pi-runtime-extension.js";

function terminal(dataDirectory: string, sessionId = "terminal") {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  let idle = true;
  let transcript: string | undefined = path.join(dataDirectory, `${sessionId}.jsonl`);
  const ctx = { isIdle: () => idle, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => transcript } } as unknown as ExtensionContext;
  createPiRuntimeExtension(dataDirectory)({ on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  return {
    emit: (name: string) => handlers.get(name)?.({ type: name }, ctx),
    setIdle: (value: boolean) => { idle = value; },
    ephemeral: () => { transcript = undefined; },
  };
}

test("terminal lifecycle keeps long tools and automatic continuations running until settled", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-extension-"));
  const pi = terminal(root);
  let db: DatabaseSync | undefined;
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  try {
    pi.emit("session_start");
    pi.setIdle(false);
    pi.emit("agent_start");
    db = new DatabaseSync(path.join(root, "node.db"));
    const running = () => Number(db!.prepare("SELECT COUNT(*) AS count FROM pi_runtime_sessions WHERE expires_at > ?").get(new Date().toISOString())!.count);
    assert.equal(running(), 1);
    t.mock.timers.tick(120_000);
    assert.equal(running(), 1, "silent long-running tests retain a fresh heartbeat");
    pi.emit("agent_end");
    assert.equal(running(), 1, "agent_end is not settled during automatic retry");
    pi.emit("agent_settled");
    assert.equal(running(), 1, "another extension may already have resumed work");
    pi.setIdle(true);
    pi.emit("agent_settled");
    t.mock.timers.tick(60_000);
    assert.equal(running(), 0, "settled turn stops and cancels heartbeat");
    pi.setIdle(false);
    pi.emit("agent_start");
    pi.emit("session_shutdown");
    t.mock.timers.tick(60_000);
    assert.equal(running(), 0, "shutdown clears the active turn");
  } finally {
    pi.emit("session_shutdown");
    db?.close();
    t.mock.timers.reset();
    await rm(root, { recursive: true, force: true });
  }
});

test("reloading a busy session reports activity and one terminal cannot stop another", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-reload-"));
  const first = terminal(root);
  const second = terminal(root);
  let db: DatabaseSync | undefined;
  try {
    first.setIdle(false);
    first.emit("session_start");
    second.setIdle(false);
    second.emit("agent_start");
    db = new DatabaseSync(path.join(root, "node.db"));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pi_runtime_sessions").get()!.count, 2);
    first.emit("session_shutdown");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pi_runtime_sessions").get()!.count, 1);
    second.emit("session_shutdown");
    first.ephemeral();
    first.emit("agent_start");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pi_runtime_sessions").get()!.count, 0);
  } finally {
    first.emit("session_shutdown");
    second.emit("session_shutdown");
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("installer loads the node-local Pi extension without duplicating or replacing user settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-install-"));
  try {
    const app = path.join(root, "app with spaces");
    const state = path.join(root, "state");
    const agent = path.join(root, "agent");
    await mkdir(path.join(app, "dist"), { recursive: true });
    await mkdir(agent);
    await writeFile(path.join(app, "package.json"), '{"type":"module"}');
    await writeFile(path.join(app, "dist/pi-runtime-extension.js"), "export const createPiRuntimeExtension = directory => () => directory;");
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ theme: "dark", extensions: ["/user/extension.ts"] }));
    const install = () => execFileSync(process.execPath, ["scripts/install-pi-runtime.mjs", app, state], { env: { ...process.env, PI_CODING_AGENT_DIR: agent } });
    install();
    install();
    const settings = JSON.parse(await readFile(path.join(agent, "settings.json"), "utf8"));
    assert.deepEqual(settings, { theme: "dark", extensions: ["/user/extension.ts", path.join(state, "pi-runtime-extension.ts")] });
    const installed = await import(pathToFileURL(settings.extensions[1]).href);
    assert.equal(installed.default(), state);
    await writeFile(path.join(agent, "settings.json"), '{"extensions":false}');
    assert.throws(install, /extensions must be an array/);
    assert.equal(await readFile(path.join(agent, "settings.json"), "utf8"), '{"extensions":false}');
  } finally { await rm(root, { recursive: true, force: true }); }
});
