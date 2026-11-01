import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { guardianHookEnvironment, guardianHookScript } from "../src/guardian/agent-token.js";
import { prepareClaudeGuardian } from "../src/guardian/claude.js";
import { kiroPermission } from "../src/guardian/kiro.js";
import { clearGuardianModelCache } from "../src/guardian/model.js";
import { DEFAULT_GUARDIAN_SETTINGS } from "../src/guardian/rules.js";
import { updateGuardianSettings } from "../src/guardian/settings.js";
import { claudeResourceIsolationArgs } from "../src/harnesses/claude/resources.js";
import { addProject } from "../src/store.js";

let app: Server;
let appUrl: string;
let model: Server;
let projectId: string;
const cwd = mkdtempSync(path.join(os.tmpdir(), "guardian-agents-"));

before(async () => {
  app = createServer((await import("../src/app.js")).createApp());
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  appUrl = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  // A decision model that says yes to deleting things and to AWS keys.
  model = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { state: string; questions: Record<string, unknown> };
      const value = /rm -rf|AKIA/.test(parsed.state) ? 0.97 : 0.02;
      response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(parsed.questions).map((id) => [id, { type: "noul", noul: value }])) }));
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const blocking = DEFAULT_GUARDIAN_SETTINGS.rules.map((rule) => rule.id === "dangerous-commands" ? { ...rule, ifYes: "block" as const } : rule);
  updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, model: "laya-remote", layaUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}`, rules: blocking });
  projectId = (await addProject("Guardian agents", cwd, { writeInstructions: false })).id;
});
after(async () => {
  updateGuardianSettings(DEFAULT_GUARDIAN_SETTINGS);
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await new Promise<void>((resolve) => model.close(() => resolve()));
});

function runHook(env: NodeJS.ProcessEnv, event: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [guardianHookScript()], { env: { ...process.env, ...env } }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin!.end(JSON.stringify(event));
  });
}

test("the Claude hook denies what Guardian blocks, lets the rest through and fails closed", async () => {
  clearGuardianModelCache();
  const env = { ...guardianHookEnvironment(projectId, "claude-conversation", cwd), JOINT_BOB_GUARDIAN_URL: `${appUrl}/api/guardian/agent` };
  const denied = JSON.parse(await runHook(env, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /srv" } }));
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /Guardian blocked this command/);
  assert.equal(await runHook(env, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }), "", "an allowed call needs no decision");
  const forged = JSON.parse(await runHook({ ...env, JOINT_BOB_GUARDIAN_TOKEN: "a".repeat(64) }, { tool_name: "Bash", tool_input: { command: "ls" } }));
  assert.equal(forged.hookSpecificOutput.permissionDecision, "deny", "a hook that cannot reach Guardian never lets a call through");
  const settings = await fetch(`${appUrl}/api/guardian`, { headers: { authorization: `Bearer ${env.JOINT_BOB_GUARDIAN_TOKEN}` } });
  assert.equal(settings.status, 401, "the hook token opens nothing else");
});

test("a Claude turn gets the hook only while a rule checks tool calls, and its message is checked first", async () => {
  clearGuardianModelCache();
  const run = await prepareClaudeGuardian(projectId, "claude-conversation", cwd, "deploy with key AKIAABCDEFGHIJKLMNOP");
  assert.ok(!run.prompt.includes("AKIAABCDEFGHIJKLMNOP"), "the secret is removed before Claude sees the message");
  assert.equal(run.hooks.PreToolUse.length, 1);
  assert.ok(run.env.JOINT_BOB_GUARDIAN_TOKEN);
  const args = claudeResourceIsolationArgs(cwd, [], undefined, run.hooks);
  const file = args[args.indexOf("--settings") + 1];
  const written = JSON.parse(readFileSync(file, "utf8")) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; timeout: number }> }> } };
  assert.match(written.hooks.PreToolUse[0].hooks[0].command, /joint-bob-guardian\.mjs/);
  assert.ok(written.hooks.PreToolUse[0].hooks[0].timeout > 600, "Claude never times the hook out before a review does");

  updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, model: "laya-remote", layaUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}`, rules: DEFAULT_GUARDIAN_SETTINGS.rules.filter((rule) => rule.check === "outgoing") });
  try {
    assert.deepEqual((await prepareClaudeGuardian(projectId, "claude-conversation", cwd, "hello")).hooks, {}, "no tool rule, no hook");
  } finally {
    const blocking = DEFAULT_GUARDIAN_SETTINGS.rules.map((rule) => rule.id === "dangerous-commands" ? { ...rule, ifYes: "block" as const } : rule);
    updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, model: "laya-remote", layaUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}`, rules: blocking });
  }
});

test("Kiro's permission request is answered with Guardian's decision", async () => {
  clearGuardianModelCache();
  const identity = { projectId, conversationId: "kiro-conversation", harness: "kiro" as const, cwd, canReplaceTool: false };
  const options = [{ optionId: "once", kind: "allow_once", name: "Allow once" }, { optionId: "no", kind: "reject_once", name: "Reject" }];
  const rejected = await kiroPermission(identity, { toolCall: { toolCallId: "1", title: "Shell", kind: "execute" }, options }, { toolName: "execute_bash", rawInput: { command: "rm -rf /" } });
  assert.deepEqual(rejected, { outcome: { outcome: "selected", optionId: "no" } });
  const allowed = await kiroPermission(identity, { toolCall: { toolCallId: "2", title: "Shell", kind: "execute" }, options }, { toolName: "execute_bash", rawInput: { command: "ls" } });
  assert.deepEqual(allowed, { outcome: { outcome: "selected", optionId: "once" } });
});
