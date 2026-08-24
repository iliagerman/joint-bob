import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Pi discovery includes flat Joint Bob sessions and standard cwd session directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-sessions-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const sessionRoot = path.join(root, "sessions");
  const projectPath = path.join(root, "project");
  const safeCwd = `--${path.resolve(projectPath).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

  try {
    for (const [index, directory] of [sessionRoot, path.join(sessionRoot, safeCwd)].entries()) {
      await mkdir(directory, { recursive: true });
      const records = [
        { type: "session", version: 3, id: `session-${index}`, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
        { type: "message", id: `user-${index}`, parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Test conversation" }], timestamp: 1 } },
        { type: "message", id: `assistant-${index}`, parentId: `user-${index}`, timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2 } },
      ];
      await writeFile(path.join(directory, `session-${index}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    }
    const { updateSettings } = await import("../src/settings.js");
    updateSettings({
      pi: { executable: "", configPath: path.join(root, "pi"), sessionPath: sessionRoot },
      claude: { executable: "", configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") },
      syncthing: { endpoint: "" },
      projects: { homePath: path.join(root, "JointBob") },
    });
    const { listPiSessions } = await import("../src/pi-service.js");

    const sessions = await listPiSessions({ path: projectPath });

    assert.equal(sessions.length, 2);
    assert.equal(new Set(sessions.map((session) => session.path)).size, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
