import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Claude hook installer preserves unrelated hooks and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-hooks-"));
  const config = path.join(root, "claude");
  const settingsPath = path.join(config, "settings.json");
  await mkdir(config, { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: "supacode start" }] }, { matcher: "startup", hooks: [{ type: "command", command: "old/joint-bob.mjs claude-event" }, { type: "command", command: "unrelated session hook" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "supacode tool" }] }],
  } }));
  try {
    const run = () => spawnSync(process.execPath, ["scripts/install-claude-hooks.mjs", "/fake/node", "/fake/app", "/fake/data"], { env: { ...process.env, CLAUDE_CONFIG_DIR: config } });
    assert.equal(run().status, 0);
    assert.equal(run().status, 0);
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "StopFailure", "SessionEnd"]) {
      const managed = settings.hooks[event].filter((entry) => entry.hooks.some((hook) => hook.command.includes("joint-bob.mjs") && hook.command.includes("claude-event")));
      assert.equal(managed.length, 1);
      assert.match(managed[0].hooks[0].command, /\/fake\/app\/bin\/joint-bob\.mjs/);
      assert.match(managed[0].hooks[0].command, /\/fake\/data/);
    }
    assert.equal(settings.hooks.SessionStart.some((entry) => entry.hooks.some((hook) => hook.command === "supacode start")), true);
    const mixedSessionStartEntry = settings.hooks.SessionStart.find((entry) => entry.matcher === "startup");
    assert.deepEqual(mixedSessionStartEntry, { matcher: "startup", hooks: [{ type: "command", command: "unrelated session hook" }] });
    assert.equal(settings.hooks.SessionStart.some((entry) => entry.hooks.some((hook) => hook.command === "old/joint-bob.mjs claude-event")), false);
    assert.equal(settings.hooks.PreToolUse.some((entry) => entry.hooks.some((hook) => hook.command === "supacode tool")), true);
    assert.equal(settings.hooks.PreToolUse.at(-1)?.matcher, "");
    assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
