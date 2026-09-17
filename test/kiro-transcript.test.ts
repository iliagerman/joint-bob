import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listDiscoveredHarnesses } from "../src/harnesses/registry.js";
import { readKiroSession } from "../src/harnesses/kiro/storage.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";

// One Kiro turn: talk, read a file, talk again, edit a file. The agent splits
// its prose into two separate messages around each tool call, so a transcript
// that merges them loses every sentence boundary.
const fixtureSource = `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("--version") || process.argv.includes("whoami")) process.exit(0);
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const notify = update => send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"native-fixed",update}});
const rl = readline.createInterface({input:process.stdin});
rl.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return send({jsonrpc:"2.0",id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
  if (request.method === "session/new") return send({jsonrpc:"2.0",id:request.id,result:{sessionId:"native-fixed"}});
  if (request.method !== "session/prompt") return;
  notify({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Reading the plan."}});
  notify({sessionUpdate:"tool_call",toolCallId:"t1",title:"Read plan.md",rawInput:{path:"plan.md"},_meta:{kiro:{toolName:"fs_read"}}});
  notify({sessionUpdate:"tool_call_update",toolCallId:"t1",status:"completed",content:[{type:"content",content:{type:"text",text:"plan body"}}]});
  notify({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"The plan is parked."}});
  notify({sessionUpdate:"tool_call",toolCallId:"t2",title:"Edit notes.md",_meta:{kiro:{toolName:"fs_write"}}});
  notify({sessionUpdate:"tool_call_update",toolCallId:"t2",status:"completed",content:[{type:"diff",path:"/tmp/notes.md",oldText:"old line",newText:"new line"}]});
  notify({sessionUpdate:"tool_call",toolCallId:"t3",title:"Run tests",_meta:{kiro:{toolName:"execute_bash"}}});
  notify({sessionUpdate:"tool_call_update",toolCallId:"t3",status:"failed",content:[{type:"content",content:{type:"text",text:"exit 1"}}]});
  send({jsonrpc:"2.0",id:request.id,result:{stopReason:"end_turn"}});
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

test("Kiro records each assistant message and tool result as its own transcript entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-transcript-"));
  const executable = path.join(root, "bin", "kiro-fixture");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, fixtureSource);
  await chmod(executable, 0o700);
  const restore = useKiroExecutable(executable);
  const runtime = await listDiscoveredHarnesses().find(({ id }) => id === "kiro")!.runtime!();
  try {
    const project = await addProject("Kiro fixture", root, { writeInstructions: false });
    const session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "segments" });
    await session.prompt({ text: "check the plan" });
    const file = session.file!;
    session.dispose();

    const stored = await readKiroSession(file.replace(/^kiro:/, ""));
    assert.deepEqual(stored.messages.map(({ role, text }) => [role, text]), [
      ["user", "check the plan"],
      ["assistant", "Reading the plan."],
      ["toolResult", "plan body"],
      ["assistant", "The plan is parked."],
      ["toolResult", "/tmp/notes.md\nnew line"],
      ["toolResult", "exit 1"],
    ], "each spoken message and tool result stays a separate entry");
    assert.deepEqual(stored.messages.map(({ toolName }) => toolName), [
      undefined, undefined, "fs_read", undefined, "fs_write", "execute_bash",
    ], "saved tool bubbles keep the name the live bubble showed");
    assert.deepEqual(stored.messages.map(({ isError }) => isError), [
      undefined, undefined, undefined, undefined, undefined, true,
    ], "a failed tool stays marked failed after a reload");
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});
