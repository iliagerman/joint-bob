import assert from "node:assert/strict";
import fsPromises, { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getHarness } from "../src/harnesses.js";
import { getSettings, updateSettings } from "../src/settings.js";

const TOTAL_TRANSCRIPTS = 25;

function piTranscript(id: string, cwd: string, title: string): string {
  return `${[
    { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd },
    { type: "message", id: `user-${id}`, parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: title }], timestamp: Date.parse("2026-01-01T00:00:01.000Z") } },
  ].map(JSON.stringify).join("\n")}\n`;
}

function claudeTranscript(cwd: string, title: string): string {
  return `${JSON.stringify({ type: "user", cwd, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ text: title }] } })}\n`;
}

for (const harnessId of ["pi", "claude"] as const) {
  test(`${harnessId} list and refresh bound transcript metadata reads`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `joint-bob-${harnessId}-list-concurrency-`));
    const previous = getSettings();
    let active = 0;
    let peak = 0;
    let operations = 0;
    const track = async <T>(filePath: unknown, operation: () => Promise<T>): Promise<T> => {
      const scoped = typeof filePath === "string" && filePath.endsWith(".jsonl") && path.resolve(filePath).startsWith(`${path.resolve(root)}${path.sep}`);
      if (!scoped) return operation();
      operations += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      try { return await operation(); }
      finally { active -= 1; }
    };
    const originalStat = fsPromises.stat.bind(fsPromises);
    const originalReadFile = fsPromises.readFile.bind(fsPromises);

    try {
      const sessionRoot = path.join(root, `${harnessId}-sessions`);
      const projectCwd = path.join(root, "project");
      await mkdir(projectCwd, { recursive: true });
      updateSettings({
        pi: { executable: "pi", configPath: path.join(root, "pi-config"), sessionPath: harnessId === "pi" ? sessionRoot : path.join(root, "pi-sessions") },
        claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: harnessId === "claude" ? sessionRoot : path.join(root, "claude-sessions") },
        syncthing: { endpoint: "" },
      });

      const directory = harnessId === "pi"
        ? path.join(sessionRoot, `--${path.resolve(projectCwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`)
        : path.join(sessionRoot, projectCwd.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-"));
      await mkdir(directory, { recursive: true });
      const files = Array.from({ length: TOTAL_TRANSCRIPTS }, (_, index) => path.join(directory, `session-${index}.jsonl`));
      await Promise.all(files.map((file, index) => writeFile(file, harnessId === "pi"
        ? piTranscript(`session-${index}`, projectCwd, `Session ${index}`)
        : claudeTranscript(projectCwd, `Session ${index}`))));

      context.mock.method(fsPromises, "stat", (filePath, options) => track(filePath, () => originalStat(filePath, options as never)) as never);
      context.mock.method(fsPromises, "readFile", (filePath, options) => track(filePath, () => originalReadFile(filePath, options as never)) as never);
      syncBuiltinESMExports();

      const adapter = getHarness(harnessId);
      const project = { id: `project-${harnessId}`, name: "Concurrency", path: projectCwd, historyDays: 30 };
      const listed = await adapter.sessions.list(project);
      assert.equal(listed.length, TOTAL_TRANSCRIPTS);
      assert.ok(operations > 0, "expected scoped transcript operations");
      assert.ok(peak <= 8, `list peak ${peak} exceeded 8`);

      await Promise.all(files.map((file, index) => writeFile(file, harnessId === "pi"
        ? piTranscript(`session-${index}`, projectCwd, `Changed session ${index}`)
        : claudeTranscript(projectCwd, `Changed session ${index}`))));
      active = 0;
      peak = 0;
      operations = 0;
      const refreshed = await adapter.sessions.refresh(project, listed, files);
      assert.equal(refreshed.length, TOTAL_TRANSCRIPTS);
      assert.ok(operations > 0, "expected scoped refresh operations");
      assert.ok(peak <= 8, `refresh peak ${peak} exceeded 8`);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      updateSettings({ pi: previous.pi, claude: previous.claude, syncthing: { endpoint: previous.syncthing.endpoint } });
      await rm(root, { recursive: true, force: true });
    }
  });
}
