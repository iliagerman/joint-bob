import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startSupervisor } from "../scripts/joint-bob-supervisor.mjs";
import { agentCapabilityEnvironment } from "../src/agent-capabilities.js";
import { resolveDataDirectory } from "../src/data-directory.js";
import { refreshSecretAgentEnvironment, secretAgentEnvironment } from "../src/secret-agent.js";
import { agentEnvironment, saveSecretAccount, setScopeSecretAccounts, deleteSecretAccount } from "../src/secrets.js";
import { addProject } from "../src/store.js";

// The three harnesses use this same shell entry point. Keep their startup environments
// unchanged across calls, as happens while one agent turn is still running.
function shell(cwd: string, env: NodeJS.ProcessEnv, expected: string): Promise<void> {
  const check = `const expected = ${JSON.stringify(expected)};
    const matched = (process.env.LIVE_SECRET ?? '') === expected &&
      process.env.UNRELATED_FIXTURE === 'keep' && !process.env.LOGIN_PASSWORD;
    process.stdout.write(matched ? 'matched' : 'mismatch');`;
  const command = `${JSON.stringify(process.execPath)} -e '${check.replaceAll("'", "'\\''")}'`;
  const child = spawn(process.execPath, [path.resolve("bin/joint-bob-bash.mjs"), "-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (part) => { stdout += part; });
  child.stderr.on("data", (part) => { stderr += part; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      try { assert.equal(code, 0, stderr); assert.equal(stdout, "matched", "new shell must use current attachments without restarting its agent"); resolve(); }
      catch (error) { reject(error); }
    });
  });
}

test("running harness shells pick up scope attachment, rotation, collisions and removal", async (t) => {
  const cwd = path.join(os.homedir(), "live-secret-project");
  await mkdir(cwd, { recursive: true });
  const project = await addProject("Live secrets", cwd, { writeInstructions: false });
  const supervisor = await startSupervisor({ dataDirectory: resolveDataDirectory(), app: {
    executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd,
    env: { PATH: process.env.PATH ?? "", HOME: os.homedir() },
  } });
  t.after(() => supervisor.close());
  const account = (label: string, value: string, id?: string) => saveSecretAccount({ id, label, provider: "custom", variables: [{ name: "LIVE_SECRET", kind: "value", value }] });
  const workspace = await account("Workspace fixture", "workspace");
  const direct = await account("Project fixture", "project");
  const conversation = await account("Conversation fixture", "conversation");
  const duplicate = await account("Ambiguous fixture", "duplicate");
  const website = await saveSecretAccount({ label: "Website fixture", provider: "website", websiteOrigin: "https://live.fixture.test", variables: [{ name: "LOGIN_PASSWORD", kind: "value", value: "website-fixture" }] });

  const baseEnv = { PATH: process.env.PATH, HOME: os.homedir(), PI_WEB_DATA_DIR: resolveDataDirectory(), UNRELATED_FIXTURE: "keep", NODE_NO_WARNINGS: "1" };
  for (const engine of ["pi", "claude", "kiro"] as const) {
    const identity = { engine, sessionId: `live-${engine}` };
    const scopeId = `${engine}:${identity.sessionId}`;
    const startup = { ...baseEnv, ...agentEnvironment(project.id, identity), ...agentCapabilityEnvironment(project.id, engine, identity.sessionId, identity), JOINT_BOB_TASK_RELAY: "http://127.0.0.1:1/unused" };
    await shell(cwd, startup, "");
    await setScopeSecretAccounts("workspace", "personal", [workspace.id, website.id]);
    await shell(cwd, startup, "workspace");
    await setScopeSecretAccounts("project", project.id, [direct.id]);
    await shell(cwd, startup, "project");
    await setScopeSecretAccounts("conversation", scopeId, [conversation.id]);
    await shell(cwd, startup, "conversation");

    // A second agent environment already contains the old value. Both it and the
    // original empty environment must refresh, without mutating either parent.
    const attached = { ...startup, ...agentEnvironment(project.id, identity) };
    await account("Rotated fixture", "rotated", conversation.id);
    await shell(cwd, startup, "rotated");
    await shell(cwd, attached, "rotated");
    await setScopeSecretAccounts("conversation", scopeId, [conversation.id, duplicate.id]);
    await shell(cwd, attached, "");
    await setScopeSecretAccounts("conversation", scopeId, []);
    await shell(cwd, attached, "project");
    await setScopeSecretAccounts("project", project.id, []);
    await shell(cwd, attached, "workspace");
    await setScopeSecretAccounts("workspace", "personal", []);
    await shell(cwd, attached, "");
    assert.equal(attached.LIVE_SECRET, "conversation", "refresh must not mutate the calling agent's environment");
    await account("Conversation fixture", "conversation", conversation.id);
  }
  await setScopeSecretAccounts("project", project.id, [direct.id]);
  const identity = { engine: "pi" as const, sessionId: "deleted" };
  const attached = { ...baseEnv, ...agentEnvironment(project.id, identity), ...agentCapabilityEnvironment(project.id, "pi", identity.sessionId, identity) };
  await deleteSecretAccount(direct.id);
  await shell(cwd, attached, "");
  await assert.rejects(shell(cwd, { ...attached, JOINT_BOB_SECRET_TOKEN: "invalid" }, ""), /Secret account access is unavailable/, "invalid tokens fail closed");
});

test("live refresh rematerializes file secrets and preserves capability settings", async () => {
  const cwd = path.join(os.homedir(), "live-secret-files");
  await mkdir(cwd, { recursive: true });
  const project = await addProject("Live secret files", cwd, { writeInstructions: false });
  const conversation = { engine: "pi" as const, sessionId: "files" };
  const file = await saveSecretAccount({ label: "File fixture", provider: "custom", variables: [{ name: "LIVE_FILE", kind: "file", value: "file-first" }] });
  await setScopeSecretAccounts("project", project.id, [file.id]);
  const startup = { ...agentEnvironment(project.id, conversation), ...secretAgentEnvironment(project.id, "pi", conversation.sessionId), PATH: "/guard/bin", JOINT_BOB_TASK_TOKEN: "task-capability", CLAUDE_CODE_SHELL: "/fixed/shell" };
  await saveSecretAccount({ id: file.id, label: "File fixture", provider: "custom", variables: [{ name: "LIVE_FILE", kind: "file", value: "file-second" }] });
  const reserved = await saveSecretAccount({ label: "Reserved fixture", provider: "custom", variables: ["PATH", "JOINT_BOB_TASK_TOKEN", "CLAUDE_CODE_SHELL"].map((name) => ({ name, kind: "value" as const, value: "must-not-override" })) });
  await setScopeSecretAccounts("project", project.id, [file.id, reserved.id]);
  const refreshed = refreshSecretAgentEnvironment(startup);
  assert.equal(await readFile(refreshed.LIVE_FILE!, "utf8"), "file-second");
  assert.equal((await stat(refreshed.LIVE_FILE!)).mode & 0o777, 0o600);
  assert.equal(refreshed.PATH, startup.PATH);
  assert.equal(refreshed.JOINT_BOB_TASK_TOKEN, startup.JOINT_BOB_TASK_TOKEN);
  assert.equal(refreshed.CLAUDE_CODE_SHELL, startup.CLAUDE_CODE_SHELL);
  assert.doesNotMatch(refreshed.JOINT_BOB_SECRET_ENV_NAMES!, /file-second|must-not-override/);
  assert.match(refreshed.JOINT_BOB_SECRET_ENV_REVISION!, /^[a-f0-9]{64}$/);
  assert.equal(refreshSecretAgentEnvironment(refreshed) === refreshed, true, "unchanged attachments reuse the environment without rebuilding files or app tokens");
  await setScopeSecretAccounts("project", project.id, []);
  const removed = refreshSecretAgentEnvironment(refreshed);
  assert.equal(removed.LIVE_FILE, undefined);
  assert.equal(removed.PATH, startup.PATH);
  assert.equal(removed.JOINT_BOB_TASK_TOKEN, startup.JOINT_BOB_TASK_TOKEN);
  assert.throws(() => refreshSecretAgentEnvironment({ ...startup, JOINT_BOB_SECRET_ENV_NAMES: '[123]' }), /Invalid secret environment names/);
  const explicit = { LIVE_FILE: "explicit-selection" };
  assert.deepEqual(refreshSecretAgentEnvironment(explicit), explicit, "secret run removes the capability so explicit selections remain untouched");
});
