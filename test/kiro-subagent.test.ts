import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listDiscoveredHarnesses } from "../src/harnesses/registry.js";
import { readKiroSession } from "../src/harnesses/kiro/storage.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";

// One Kiro turn that delegates to a sub-agent. Kiro streams the sub-agent's
// work on the same connection under the sub-agent's own session ID, so the
// parent turn must keep going instead of treating those updates as fatal.
const fixtureSource = `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("--version") || process.argv.includes("whoami")) process.exit(0);
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const notify = (sessionId, update) => send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update}});
const rl = readline.createInterface({input:process.stdin});
rl.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return send({jsonrpc:"2.0",id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
  if (request.method === "session/new") return send({jsonrpc:"2.0",id:request.id,result:{sessionId:"native-parent"}});
  if (request.method !== "session/prompt") return;
  notify("native-parent", {sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Delegating."}});
  notify("native-parent", {sessionUpdate:"tool_call",toolCallId:"t1",title:"Run sub-agent",_meta:{kiro:{toolName:"subagent"}}});
  notify("native-child", {sessionUpdate:"agent_message_chunk",content:{type:"text",text:"child chatter"}});
  notify("native-child", {sessionUpdate:"tool_call",toolCallId:"c1",title:"Read file",_meta:{kiro:{toolName:"fs_read"}}});
  notify("native-child", {sessionUpdate:"tool_call_update",toolCallId:"c1",status:"completed",content:[{type:"content",content:{type:"text",text:"child file"}}]});
  notify("native-parent", {sessionUpdate:"tool_call_update",toolCallId:"t1",status:"completed",content:[{type:"content",content:{type:"text",text:"child summary"}}]});
  notify("native-parent", {sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Sub-agent finished."}});
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

test("Kiro turn survives a sub-agent streaming under its own session ID", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-subagent-"));
  const executable = path.join(root, "bin", "kiro-fixture");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, fixtureSource);
  await chmod(executable, 0o700);
  const restore = useKiroExecutable(executable);
  const runtime = await listDiscoveredHarnesses().find(({ id }) => id === "kiro")!.runtime!();
  try {
    const project = await addProject("Kiro sub-agent fixture", root, { writeInstructions: false });
    const session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "subagent-parent" });
    await session.prompt({ text: "delegate the review" });
    const file = session.file!;
    session.dispose();

    const stored = await readKiroSession(file.replace(/^kiro:/, ""));
    assert.deepEqual(stored.messages.map(({ role, text }) => [role, text]), [
      ["user", "delegate the review"],
      ["assistant", "Delegating."],
      ["toolResult", "child summary"],
      ["assistant", "Sub-agent finished."],
    ], "the parent turn finishes and only the parent's own messages are recorded");
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});
