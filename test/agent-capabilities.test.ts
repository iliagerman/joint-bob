import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(message);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout;
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", resolve)),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, 12_000); }),
  ]);
  clearTimeout(timer!);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", resolve));
  }
}

async function startSupervisor(root: string, state: string): Promise<{ child: ChildProcess; socketPath: string }> {
  const app = path.join(root, "app.mjs");
  await writeFile(app, "setInterval(()=>{},1000)");
  const child = spawn(process.execPath, ["scripts/joint-bob-supervisor.mjs", "--data-dir", state, "--app", app, "--cwd", root], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (part) => { stdout += part; });
  child.stderr!.on("data", (part) => { stderr += part; });
  try {
    await waitFor(() => stdout.includes("\n") || child.exitCode !== null, `supervisor unavailable: ${stderr}`);
    if (child.exitCode !== null) throw new Error(stderr);
    return { child, socketPath: JSON.parse(stdout.slice(0, stdout.indexOf("\n"))).socketPath as string };
  } catch (error) {
    await stop(child);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function capabilityFlags(): Record<string, boolean | string | undefined> {
  return {
    taskCli: Boolean(process.env.JOINT_BOB_TASK_CLI),
    taskSocket: Boolean(process.env.JOINT_BOB_TASK_SOCKET),
    taskToken: Boolean(process.env.JOINT_BOB_TASK_TOKEN),
    adminToken: process.env.JOINT_BOB_SUPERVISOR_TOKEN,
    browser: Boolean(process.env.JOINT_BOB_BROWSER_TOKEN),
    fixture: process.env.JOINT_BOB_CAPABILITY_FIXTURE,
    managedShell: Boolean(process.env.JOINT_BOB_TASK_SHELL),
    claudeShell: process.env.CLAUDE_CODE_SHELL === process.env.JOINT_BOB_TASK_SHELL,
    kiroShell: process.env.KIRO_CHAT_SHELL === process.env.JOINT_BOB_TASK_SHELL,
  };
}

test("shared capabilities reach Claude, Pi, and Kiro channels with one logical task scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-capabilities-"));
  const state = path.join(root, "state");
  const previousData = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = state;
  const supervisor = await startSupervisor(root, state);
  let pi: { dispose(): void } | undefined;
  let kiro: { dispose(): void } | undefined;
  try {
    const [{ agentCapabilities }, { getSettings, updateSettings }, { addProject }] = await Promise.all([
      import("../src/agent-capabilities.js"), import("../src/settings.js"), import("../src/store.js"),
    ]);
    const previous = getSettings();
    const project = await addProject("Capability fixture", root, { writeInstructions: false });
    const executable = path.join(root, "adapter-fixture.mjs");
    const capture = path.join(root, "capture.jsonl");
    await writeFile(executable, `#!/usr/bin/env node\nimport fs from "node:fs";\nconst flags={taskCli:Boolean(process.env.JOINT_BOB_TASK_CLI),taskSocket:Boolean(process.env.JOINT_BOB_TASK_SOCKET),taskToken:Boolean(process.env.JOINT_BOB_TASK_TOKEN),adminToken:process.env.JOINT_BOB_SUPERVISOR_TOKEN,browser:Boolean(process.env.JOINT_BOB_BROWSER_TOKEN),fixture:process.env.JOINT_BOB_CAPABILITY_FIXTURE,managedShell:Boolean(process.env.JOINT_BOB_TASK_SHELL),claudeShell:process.env.CLAUDE_CODE_SHELL===process.env.JOINT_BOB_TASK_SHELL,kiroShell:process.env.KIRO_CHAT_SHELL===process.env.JOINT_BOB_TASK_SHELL};\nfs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),flags})+"\\n");\nif(process.argv.includes("--version")||process.argv.includes("whoami"))process.exit(0);\nconst i=process.argv.indexOf("--append-system-prompt-file");if(i>=0)fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({instructions:fs.readFileSync(process.argv[i+1],"utf8")})+"\\n");\nconsole.log(JSON.stringify({type:"system",subtype:"init",session_id:"shared_conversation",tools:["Bash"]}));console.log(JSON.stringify({type:"result",is_error:false}));\n`);
    await chmod(executable, 0o700);
    const configPath = path.join(root, "config");
    await mkdir(path.join(configPath, "sessions"), { recursive: true });
    updateSettings({ ...previous, runtimes: { ...previous.runtimes, claude: { executable, configPath, sessionPath: path.join(root, "claude-sessions") }, kiro: { executable, configPath, sessionPath: path.join(configPath, "sessions") } }, claude: { executable, configPath, sessionPath: path.join(root, "claude-sessions") }, pi: { ...previous.pi, configPath: path.join(root, "pi"), sessionPath: path.join(root, "pi-sessions") } });
    agentCapabilities.push({ id: "fixture", instructions: { path: "/virtual/FIXTURE.md", content: "FIXTURE_CAPABILITY_TEXT" }, environment: () => ({ JOINT_BOB_CAPABILITY_FIXTURE: "yes" }) });
    try {
      const conversationId = "shared_conversation";
      const { runClaudeConversationPrompt } = await import("../src/claude-service.js");
      const claude = await runClaudeConversationPrompt({ cwd: root, projectId: project.id, sessionId: conversationId, prompt: "fixture", onEvent: () => {} });
      assert.equal((await claude.done).ok, true);

      const { createPiSession } = await import("../src/pi-service.js");
      pi = await createPiSession({ cwd: root, projectId: project.id, sessionId: conversationId, conversationId });
      const systemPrompt = pi.session.agent.state.systemPrompt as string;
      assert.match(systemPrompt, /FIXTURE_CAPABILITY_TEXT/);
      assert.match(systemPrompt, /Joint Bob tasks/);
      assert.match(systemPrompt, /Joint Bob browser/);
      assert.match(systemPrompt, /Joint Bob goals/);
      const bash = pi.session.agent.state.tools.find((tool: { name: string }) => tool.name === "bash");
      const result = await bash.execute("probe", { command: `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify((${capabilityFlags.toString()})()))'` });
      const outputLines = (result.content[0] as { text: string }).text.trim().split("\n").filter(Boolean);
      const jsonLines = outputLines.filter((line) => line.startsWith("{"));
      assert.equal(jsonLines.length, 1, `expected one JSON output line, received: ${outputLines.join(" | ")}`);
      for (const line of outputLines.filter((line) => !line.startsWith("{"))) assert.match(line, /^(?:\(node:\d+\) )?ExperimentalWarning: SQLite is an experimental feature|^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/);
      const piFlags = JSON.parse(jsonLines[0]) as ReturnType<typeof capabilityFlags>;
      assert.deepEqual(piFlags, { taskCli: true, taskSocket: true, taskToken: true, browser: true, fixture: "yes", managedShell: true, claudeShell: true, kiroShell: true });

      const { default: runtime } = await import("../src/harnesses/kiro/runtime.js");
      kiro = await runtime.open({ cwd: root, projectId: project.id, sessionId: conversationId, conversationId });
      await kiro.preflight();
      const { kiroAgentProfile } = await import("../src/harnesses/kiro/resources.js");
      const profileName = await kiroAgentProfile({ cwd: root, projectId: project.id, sessionId: conversationId, conversationId }, "fixture credentials");
      const profile = JSON.parse(await readFile(path.join(configPath, "agents", `${profileName}.json`), "utf8")) as { prompt: string };
      for (const marker of ["FIXTURE_CAPABILITY_TEXT", "Joint Bob tasks", "Joint Bob browser", "Joint Bob goals", "fixture credentials"]) assert.match(profile.prompt, new RegExp(marker));

      const records = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { flags?: ReturnType<typeof capabilityFlags>; instructions?: string });
      const adapterFlags = records.filter((record) => record.flags).map((record) => record.flags!);
      assert.ok(adapterFlags.length >= 3);
      for (const flags of adapterFlags) assert.deepEqual(flags, { taskCli: true, taskSocket: true, taskToken: true, browser: true, fixture: "yes", managedShell: true, claudeShell: true, kiroShell: true });
      const claudeInstructions = records.find((record) => record.instructions)?.instructions ?? "";
      for (const marker of ["FIXTURE_CAPABILITY_TEXT", "Joint Bob tasks", "Joint Bob browser", "Joint Bob goals"]) assert.match(claudeInstructions, new RegExp(marker));

      const client = await import("../scripts/supervisor-client.mjs");
      const control = client.readSupervisorControl(state)!;
      const taskToken = client.mintTaskToken(state, JSON.stringify([project.id, conversationId]));
      assert.notEqual(control.token, taskToken);
      const tasks = await client.requestSupervisor(control.socketPath, taskToken, { action: "list" }) as Array<Record<string, unknown>>;
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].name, "Shell command");
      assert.equal(tasks[0].status, "completed");
      assert.equal(tasks[0].identity, JSON.stringify([project.id, conversationId]));
    } finally {
      const index = agentCapabilities.findIndex((capability) => capability.id === "fixture");
      if (index >= 0) agentCapabilities.splice(index, 1);
      updateSettings(previous);
    }
  } finally {
    pi?.dispose();
    kiro?.dispose();
    await stop(supervisor.child);
    if (previousData === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previousData;
    await rm(root, { recursive: true, force: true });
  }
});

test("task capability reports unavailable without creating supervisor state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-capabilities-none-"));
  const previousData = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = root;
  try {
    const { agentCapabilityEnvironment, agentCapabilityInstructionFiles } = await import("../src/agent-capabilities.js");
    const environment = agentCapabilityEnvironment("project", "pi", "conversation");
    assert.equal(Boolean(environment.JOINT_BOB_TASK_CLI), true);
    assert.equal(environment.JOINT_BOB_TASK_SOCKET, undefined);
    assert.equal(environment.JOINT_BOB_TASK_TOKEN, undefined);
    const instructions = agentCapabilityInstructionFiles().map((file) => file.content).join("\n");
    assert.match(instructions, /Completions enqueue an automatic follow-up/);
    assert.match(instructions, /Supported extensions and external job producers must launch their process through this CLI/);
    assert.match(instructions, /Never use it for ordinary shell commands/);
    assert.match(instructions, /expected to run longer than the current turn/);
    assert.doesNotMatch(instructions, /automatic conversation wakeup is not implemented/);
    assert.match(instructions, /unsupported node mode/);
    await assert.rejects(readFile(path.join(root, "supervisor.db")));
  } finally {
    if (previousData === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previousData;
    await rm(root, { recursive: true, force: true });
  }
});
