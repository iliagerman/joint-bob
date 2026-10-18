// An agent under a person's OS account can't open the supervisor socket or the node
// database, so its shell commands and background tasks go through the server's relay. A
// stand-in helper keeps the same OS user, which proves the plumbing, not the machine wall.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { configure, environment, startServer, stopServer, temporaryRoot } from "./queued-prompt-harness.js";

function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (part) => { stdout += part; });
  child.stderr.on("data", (part) => { stderr += part; });
  return new Promise((resolve) => child.once("close", (code) => resolve({ code, stdout, stderr })));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("agents under an account run shells and tasks through the relay, as that account", { timeout: 120_000 }, async () => {
  const root = await temporaryRoot("jb-relay-");
  const previous = { ...process.env };
  const homes = path.join(root, "homes");
  Object.assign(process.env, environment(root), {
    JOINT_BOB_USERCTL: path.resolve("test/fixtures/fake-userctl.sh"),
    JOINT_BOB_USERCTL_SUDO: "0",
    JOINT_BOB_ACCOUNT_HOME_ROOT: homes,
  });
  await mkdir(homes, { recursive: true });
  let server: Server | undefined;
  let supervisor: { close: () => Promise<void> } | undefined;
  try {
    const data = process.env.JOINT_BOB_DATA_DIR!;
    await mkdir(data, { recursive: true, mode: 0o700 });
    const { startSupervisor } = await import("../scripts/joint-bob-supervisor.mjs");
    supervisor = await startSupervisor({ dataDirectory: data, app: { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root, env: { PATH: process.env.PATH ?? "", HOME: root } } });
    const { save, settingsDatabase } = await import("../src/settings-store.js");
    save(settingsDatabase(), "multiUser.enabled", "true");
    const started = await startServer();
    server = started.server;
    // In multi-user mode a person's project folder is in their own home.
    const fixture = await configure(started.baseUrl, root, "", path.join(homes, "jb-admin", "JointBob", "project"));
    const { mintTaskToken } = await import("../scripts/supervisor-client.mjs");
    const token = mintTaskToken(data, JSON.stringify([fixture.projectId, "conversation-a"]));
    const other = mintTaskToken(data, JSON.stringify([fixture.projectId, "conversation-b"]));
    const accountHome = path.join(homes, "jb-admin");
    await mkdir(path.join(accountHome, ".tmp"), { recursive: true });
    // What an agent in the account sees: no socket, no data directory, the relay and a token.
    const agentEnv = {
      PATH: process.env.PATH ?? "", HOME: accountHome, TMPDIR: path.join(accountHome, ".tmp"), NODE_NO_WARNINGS: "1",
      JOINT_BOB_TASK_RELAY: `${started.baseUrl}/api/background-tasks/relay`, JOINT_BOB_TASK_TOKEN: token,
    };
    const project = path.join(homes, "jb-admin", "JointBob", "project");

    const shell = await run(process.execPath, [path.resolve("bin/joint-bob-bash.mjs"), "-c", "printf \"$JOINT_BOB_FAKE_ACCOUNT in $PWD\"; exit 3"], project, agentEnv);
    assert.equal(shell.code, 3, JSON.stringify(shell));
    assert.equal(shell.stdout, `admin in ${await import("node:fs").then((fs) => fs.realpathSync(project))}`, "the command ran through the helper as the project's account, in its folder");
    const db = new DatabaseSync(path.join(data, "node.db"), { readOnly: true });
    try {
      const calls = db.prepare("SELECT state FROM supervised_shell_calls").all() as Array<{ state: string }>;
      assert.deepEqual(calls.map((call) => call.state), ["returned"], "the relay recorded the short call so Tasks hides it");
    } finally { db.close(); }

    // Worker shells have no access to the service's database. The relay must resolve
    // changes for their pinned conversation, including a non-initial harness segment.
    const secrets = await import("../src/secrets.js");
    const { secretAgentEnvironment } = await import("../src/secret-agent.js");
    const { ensureConversationRecord } = await import("../src/conversation-records.js");
    const { getClusterNode } = await import("../src/cluster.js");
    await ensureConversationRecord(fixture.projectId, "pi", "segment-a", (await getClusterNode()).id, undefined, { conversationId: "conversation-a", segmentIndex: 1 });
    const conversation = { engine: "pi" as const, sessionId: "segment-a" };
    const emptyEnv = { ...agentEnv, ...secrets.agentEnvironment(fixture.projectId, conversation), ...secretAgentEnvironment(fixture.projectId, "pi", conversation.sessionId) };
    const saved = await secrets.saveSecretAccount({ label: "Relay fixture", provider: "custom", variables: [{ name: "RELAY_SECRET_FIXTURE", kind: "value", value: "relay-first" }] });
    await secrets.setScopeSecretAccounts("workspace", "personal", [saved.id]);
    const check = async (env: NodeJS.ProcessEnv, expected: string) => {
      const result = await run(process.execPath, [path.resolve("bin/joint-bob-bash.mjs"), "-c", `test "$RELAY_SECRET_FIXTURE" = '${expected}' && printf matched`], project, env);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "matched", "the relay refreshes without worker database access or a new prompt");
    };
    await check(emptyEnv, "relay-first");
    const staleEnv = { ...emptyEnv, ...secrets.agentEnvironment(fixture.projectId, conversation) };
    await secrets.saveSecretAccount({ id: saved.id, label: "Relay fixture", provider: "custom", variables: [{ name: "RELAY_SECRET_FIXTURE", kind: "value", value: "relay-second" }] });
    await check(staleEnv, "relay-second");
    await secrets.setScopeSecretAccounts("workspace", "personal", []);
    await check(staleEnv, "");
    const wrongConversation = await run(process.execPath, [path.resolve("bin/joint-bob-bash.mjs"), "-c", "printf unauthorized"], project, { ...staleEnv, JOINT_BOB_TASK_TOKEN: other });
    assert.notEqual(wrongConversation.code, 0);
    assert.match(wrongConversation.stderr, /does not match this conversation/);
    assert.doesNotMatch(wrongConversation.stdout, /unauthorized/);

    const cli = path.resolve("bin/joint-bob-task.mjs");
    const startedTask = await run(process.execPath, [cli, "start", "--name", "server", "--", "/bin/sh", "-c", "echo up; exec sleep 60"], project, agentEnv);
    assert.equal(startedTask.code, 0, startedTask.stderr);
    const task = JSON.parse(startedTask.stdout) as { id: string; pid: number };
    let output = "";
    for (let attempt = 0; attempt < 80 && !output.includes("up"); attempt++) {
      await delay(50);
      output = (await run(process.execPath, [cli, "output", task.id], project, agentEnv)).stdout;
    }
    assert.equal(output, "up\n");
    const foreign = await run(process.execPath, [cli, "status", task.id], project, { ...agentEnv, JOINT_BOB_TASK_TOKEN: other });
    assert.notEqual(foreign.code, 0, "another conversation's token can't read the task");
    const state = await fetch(`${started.baseUrl}/api/background-tasks/relay`, { method: "POST", headers: { Authorization: `Bearer ${other}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "shell-state", id: task.id, state: "returned", until: 0 }) });
    assert.equal(state.status, 404, "nor hide it from Tasks");
    const stopped = await run(process.execPath, [cli, "stop", task.id], project, agentEnv);
    assert.equal(stopped.code, 0, stopped.stderr);
    let status = "";
    for (let attempt = 0; attempt < 200 && !["stopped", "completed", "failed"].includes(status); attempt++) {
      await delay(50);
      status = (JSON.parse((await run(process.execPath, [cli, "status", task.id], project, agentEnv)).stdout) as { status: string }).status;
    }
    assert.equal(status, "stopped");
    assert.match(await readFile(path.join(homes, "runs.log"), "utf8"), /^admin$/m);
  } finally {
    await stopServer(server);
    await supervisor?.close();
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});
