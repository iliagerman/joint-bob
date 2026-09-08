import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appSource, serverSource } from "./source.js";

test("Claude sub-agent transcripts list as read-only children of their parent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-subagents-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = root;
  try {
    const sessionRoot = path.join(root, "claude-sessions");
    const projectCwd = path.join(root, "project");
    await mkdir(projectCwd, { recursive: true });
    const settings = await import(`../src/settings.js?cache=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      pi: { executable: "pi", configPath: path.join(root, "pi-config"), sessionPath: path.join(root, "pi-sessions") },
      claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: sessionRoot },
      syncthing: { endpoint: "" },
    });
    const sessionPaths = await import(`../src/session-paths.js?cache=${Date.now()}-${Math.random()}`);
    const claude = await import(`../src/claude-service.js?cache=${Date.now()}-${Math.random()}`);
    const projectDir = sessionPaths.claudeProjectDir(projectCwd, sessionRoot);
    const subagentDir = path.join(projectDir, "parent-session", "subagents");
    await mkdir(subagentDir, { recursive: true });
    const line = (title: string): string =>
      `${JSON.stringify({ type: "user", cwd: projectCwd, message: { role: "user", content: [{ text: title }] } })}\n`;
    await writeFile(path.join(projectDir, "parent-session.jsonl"), line("Parent work"));
    await writeFile(path.join(subagentDir, "agent-abc.jsonl"), line("Child task"));
    await writeFile(path.join(subagentDir, "agent-abc.sync-conflict-20260101-000000-AAAA.jsonl"), line("Conflict copy"));

    const files = await claude.claudeSessionFiles({ path: projectCwd });
    assert.ok(files.includes(path.join(subagentDir, "agent-abc.jsonl")));
    assert.ok(!files.some((file: string) => file.includes("sync-conflict")));

    const sessions = await claude.listClaudeSessions({ path: projectCwd });
    const parent = sessions.find((session: { id: string }) => session.id === "parent-session");
    const child = sessions.find((session: { id: string }) => session.id === "parent-session/agent-abc");
    assert.ok(parent);
    assert.ok(child);
    assert.equal(child.parentSessionPath, `claude:${path.join(projectDir, "parent-session.jsonl")}`);
    assert.equal(child.readOnly, true);
    assert.equal(child.title, "[Claude] Child task");
    assert.equal(parent.readOnly, undefined);
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only conversations skip ownership and fence writes on the server", async () => {
  const server = await serverSource();
  assert.match(server, /const sessionReadOnly = listedSession\?\.readOnly === true;/);
  assert.match(server, /if \(!sessionReadOnly\) \{[\s\S]*openConversationOwnership/);
  assert.match(server, /if \(connection\.readOnly\) throw new Error\("This conversation is read-only"\);/);
});

test("the conversation list hides mutating actions on read-only rows and shows worker output", async () => {
  const app = await appSource();
  assert.match(app, /const readOnly = session\.readOnly === true \|\| sessionTicketTask\(session\)\?\.status === "done";/);
  assert.match(app, /taskElement\.title = task\.task;/);
  assert.match(app, /agent-run-task-output/);
});
