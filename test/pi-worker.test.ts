// In multi-user mode a Pi conversation runs in a worker under its project's OS account. A
// stand-in helper keeps the same OS user but gives each account its own home, which is
// enough to prove the server runs Pi there, writes its transcript there, and streams back.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type WebSocket from "ws";
import { configure, environment, openChat, startServer, stopServer, temporaryRoot, waitFor } from "./queued-prompt-harness.js";

function fakeModel(): Promise<{ server: Server; url: string; prompts: string[]; authorizations: string[] }> {
  const prompts: string[] = [];
  const authorizations: string[] = [];
  const server = createServer((request, response) => {
    authorizations.push(String(request.headers.authorization ?? ""));
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try { prompts.push(JSON.stringify(JSON.parse(body).messages)); } catch { prompts.push(body); }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.write(chunk({ role: "assistant", content: "hi from the worker" }, null));
      response.write(chunk({}, "stop"));
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address() as { port: number };
    resolve({ server, url: `http://127.0.0.1:${address.port}/v1`, prompts, authorizations });
  }));
}

async function files(root: string): Promise<string[]> {
  try { return (await readdir(root, { recursive: true })).map((entry) => String(entry)); } catch { return []; }
}

test("a Pi conversation runs in a worker under its project's account and writes there", { timeout: 120_000 }, async () => {
  const root = await temporaryRoot("joint-bob-pi-worker-");
  const previous = { ...process.env };
  const model = await fakeModel();
  const homes = path.join(root, "homes");
  const serviceAgent = path.join(root, "pi");
  Object.assign(process.env, environment(root), {
    PI_CODING_AGENT_DIR: serviceAgent,
    JOINT_BOB_USERCTL: path.resolve("test/fixtures/fake-userctl.sh"),
    JOINT_BOB_USERCTL_SUDO: "0",
    JOINT_BOB_ACCOUNT_HOME_ROOT: homes,
  });
  await mkdir(serviceAgent, { recursive: true });
  await mkdir(homes, { recursive: true });
  const nativeAgent = path.join(homes, "jb-admin", ".pi", "agent");
  const nativeMarker = path.join(nativeAgent, "native-extension-ran");
  await mkdir(path.join(nativeAgent, "extensions"), { recursive: true });
  await writeFile(path.join(nativeAgent, "AGENTS.md"), "NATIVE_WORKER_INSTRUCTIONS");
  await writeFile(path.join(nativeAgent, "extensions", "native.ts"), `import { writeFileSync } from "node:fs"; export default () => writeFileSync(${JSON.stringify(nativeMarker)}, "ran");`);
  await writeFile(path.join(serviceAgent, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: model.url, api: "openai-completions",
    models: [{ id: "fixture-model", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 512 }],
  } } }));
  // The node's sign-in for the provider; the worker may use it but never gets the file.
  await writeFile(path.join(serviceAgent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "node-signed-in-key" } }), { mode: 0o600 });
  let server: Server | undefined;
  const sockets: WebSocket[] = [];
  try {
    const settings = await import("../src/settings.js");
    settings.updateSettings({ pi: { executable: "", configPath: serviceAgent, sessionPath: path.join(serviceAgent, "sessions") }, claude: { executable: "", configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") }, syncthing: { endpoint: "" } });
    const current = settings.getSettings();
    settings.updateSettings({ ...current, conversationDefaults: { ...current.conversationDefaults, pi: { provider: "fixture", modelId: "fixture-model", thinkingLevel: "off" } } });
    const { save, settingsDatabase } = await import("../src/settings-store.js");
    save(settingsDatabase(), "multiUser.enabled", "true");
    const started = await startServer();
    server = started.server;
    // In multi-user mode a person's project folder is in their own home.
    const fixture = await configure(started.baseUrl, root, "", path.join(homes, "jb-admin", "JointBob", "project"));

    const opened = openChat(started.baseUrl, fixture.cookie, fixture.projectId, "new");
    sockets.push(opened.socket);
    await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "ready" || frame.type === "error"), 60_000);
    assert.deepEqual(opened.messages.filter((frame) => frame.type === "error"), [], "the worker opens the session");
    opened.socket.send(JSON.stringify({ type: "prompt", message: "hello worker" }));
    await waitFor(opened.messages, () => opened.messages.some((frame) => frame.type === "assistantFinal" || frame.type === "assistantError" || frame.type === "error"), 60_000);
    const final = opened.messages.find((frame) => frame.type === "assistantFinal") as { text?: string } | undefined;
    assert.equal(final?.text, "hi from the worker", JSON.stringify(opened.messages.filter((frame) => /error/i.test(String(frame.type)))));

    const admin = path.join(homes, "jb-admin");
    const transcripts = (await files(path.join(admin, ".pi", "agent", "sessions"))).filter((name) => name.endsWith(".jsonl"));
    assert.equal(transcripts.length, 1, "the transcript is written in the account's home");
    assert.deepEqual((await files(path.join(serviceAgent, "sessions"))).filter((name) => name.endsWith(".jsonl")), [], "and never in the service's");
    assert.match(await readFile(path.join(homes, "runs.log"), "utf8"), /^admin$/m, "the worker ran through the helper as the admin's account");
    assert.ok(await readFile(path.join(admin, ".pi", "agent", "models.json"), "utf8"), "the node's model list was provisioned for the account");
    assert.ok(model.prompts.some((prompt) => prompt.includes("hello worker")), "the prompt reached the model from the worker");
    assert.equal(model.prompts.some((prompt) => prompt.includes("NATIVE_WORKER_INSTRUCTIONS")), false);
    await assert.rejects(readFile(nativeMarker), { code: "ENOENT" }, "the worker never executes native extensions");
    assert.ok(model.authorizations.includes("Bearer node-signed-in-key"), "with the node's sign-in, read through the server");
    await assert.rejects(readFile(path.join(admin, ".pi", "agent", "auth.json")), "the account never holds the node's sign-ins");
  } finally {
    for (const socket of sockets) socket.terminate();
    const { stopPiWorkers } = await import("../src/harnesses/pi/remote.js");
    stopPiWorkers();
    await stopServer(server);
    model.server.close();
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});
