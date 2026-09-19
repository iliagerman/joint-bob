import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listDiscoveredHarnesses } from "../src/harnesses/registry.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";

// Kiro reports a quota problem twice: a `_kiro.dev/error/*` notification with the
// human-readable reason, then a JSON-RPC error whose `message` is only
// "Internal error" and whose `data` carries the detail. The user must see the
// reason, never the bare "Internal error".
const fixtureSource = `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("--version") || process.argv.includes("whoami")) process.exit(0);
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = readline.createInterface({input:process.stdin});
rl.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return send({jsonrpc:"2.0",id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
  if (request.method === "session/new") return send({jsonrpc:"2.0",id:request.id,result:{sessionId:"native-limited"}});
  if (request.method !== "session/prompt") return;
  if (process.env.KIRO_FIXTURE_EMPTY_TURN === "1") return send({jsonrpc:"2.0",id:request.id,result:{stopReason:"end_turn"}});
  if (process.env.KIRO_FIXTURE_NOTIFY === "1") send({jsonrpc:"2.0",method:"_kiro.dev/error/rate_limit",params:{sessionId:"native-limited",message:"The monthly usage limit has been reached"}});
  send({jsonrpc:"2.0",id:request.id,error:{code:-32603,message:"Internal error",data:"Encountered an error in the response stream: The monthly usage limit has been reached (request_id: abc)"}});
});
rl.on("close", () => process.exit(0));
`;

function useKiroExecutable(executable: string): () => void {
  const previous = getSettings();
  const base = {
    syncthing: { endpoint: previous.syncthing.endpoint },
    projects: previous.projects,
    resources: previous.resources,
    conversationLabels: previous.conversationLabels,
    conversationHistoryDays: previous.conversationHistoryDays,
    conversationDefaults: previous.conversationDefaults,
  };
  updateSettings({ ...base, runtimes: { ...previous.runtimes, kiro: { ...previous.runtimes.kiro, executable } } });
  return () => updateSettings({ ...base, runtimes: previous.runtimes });
}

async function failedPromptMessage(notify: boolean, emptyTurn = false): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-prompt-failure-"));
  const executable = path.join(root, "bin", "kiro-fixture");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, fixtureSource);
  await chmod(executable, 0o700);
  const restore = useKiroExecutable(executable);
  const previousNotify = process.env.KIRO_FIXTURE_NOTIFY;
  const previousEmpty = process.env.KIRO_FIXTURE_EMPTY_TURN;
  process.env.KIRO_FIXTURE_NOTIFY = notify ? "1" : "0";
  process.env.KIRO_FIXTURE_EMPTY_TURN = emptyTurn ? "1" : "0";
  const runtime = await listDiscoveredHarnesses().find(({ id }) => id === "kiro")!.runtime!();
  try {
    const project = await addProject(`Kiro failure fixture ${notify} ${emptyTurn}`, root, { writeInstructions: false });
    const session = await runtime.open({ projectId: project.id, cwd: root, sessionId: `limited-${notify}-${emptyTurn}` });
    try {
      await session.prompt({ text: "hello" });
      assert.fail("the prompt must fail when Kiro rejects the turn");
    } catch (error) {
      return (error as Error).message;
    } finally {
      session.dispose();
    }
  } finally {
    if (previousNotify === undefined) delete process.env.KIRO_FIXTURE_NOTIFY;
    else process.env.KIRO_FIXTURE_NOTIFY = previousNotify;
    if (previousEmpty === undefined) delete process.env.KIRO_FIXTURE_EMPTY_TURN;
    else process.env.KIRO_FIXTURE_EMPTY_TURN = previousEmpty;
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

test("a Kiro error notification becomes the prompt failure message", async () => {
  const message = await failedPromptMessage(true);
  assert.equal(message, "The monthly usage limit has been reached");
});

test("a Kiro error reply keeps its detail when no notification explains it", async () => {
  const message = await failedPromptMessage(false);
  assert.match(message, /The monthly usage limit has been reached/);
  assert.notEqual(message, "Internal error");
});

// When the provider rejects the model call after a tool result, Kiro logs the
// error privately and still answers end_turn with no text. Silence is a failure.
test("a Kiro turn that ends without any reply is a prompt failure", async () => {
  const message = await failedPromptMessage(false, true);
  assert.equal(message, "Kiro ended the turn without a reply. The model provider may have rejected the request; check Kiro's log for details.");
});
