import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getHarnessRuntime } from "../src/harnesses.js";
import type { HarnessEvent } from "../src/harnesses/runtime.js";
import { updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";

/** When Joint Bob stops a turn, the turn fails with why it was stopped, not with how the process died. */
test("a Claude turn Joint Bob stops fails with the stop reason", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-stop-"));
  const fakeClaude = path.join(root, "claude-fake");
  await writeFile(fakeClaude, [
    "#!/bin/sh",
    "cat >/dev/null",
    `echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Still working."}]}}'`,
    "exec sleep 30",
    "",
  ].join("\n"), "utf8");
  await chmod(fakeClaude, 0o755);
  updateSettings({
    projects: { homePath: path.join(root, "home") },
    claude: { executable: fakeClaude, configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-projects") },
    syncthing: { endpoint: "" },
  });
  const project = await addProject(`claude-stop-${Date.now()}`, path.join(root, "project"), { writeInstructions: false });
  const runtime = await getHarnessRuntime("claude");
  const session = await runtime.open({ projectId: project.id, cwd: project.path, sessionId: crypto.randomUUID(), accountIds: [] });
  let answered!: () => void;
  const streaming = new Promise<void>((resolve) => { answered = resolve; });
  session.subscribe((event: HarnessEvent) => { if (event.type === "textDelta") answered(); });

  const turn = session.prompt({ text: "hello" });
  await streaming;
  const failed = assert.rejects(turn, { message: "Joint Bob stopped the turn after 5 minutes with no input or output" });
  await session.cancel("Joint Bob stopped the turn after 5 minutes with no input or output");
  await failed;
});
