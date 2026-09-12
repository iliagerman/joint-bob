import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeSessionFilePath } from "../src/claude-service.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { HarnessSessionCatalog, clearHarnessSessionCache, defineHarness, listHarnessSessions, refreshHarnessSessions } from "../src/harnesses.js";
import type { SessionSummary } from "../src/types.js";

test("partial watcher refresh does not cache an atomic fork as a draft", async (t) => {
  const project = { id: randomUUID(), name: "Fork catalog", path: path.join(os.homedir(), randomUUID()) };
  const sourceId = randomUUID(), forkId = randomUUID();
  const sourcePath = claudeSessionFilePath(project.path, sourceId);
  const forkPath = claudeSessionFilePath(project.path, forkId);
  t.after(async () => {
    clearHarnessSessionCache(project.id);
    await rm(path.dirname(sourcePath), { recursive: true, force: true });
  });
  const contents = JSON.stringify({ type: "user", cwd: project.path, message: { role: "user", content: "complete history" } }) + "\n";
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, contents);
  assert.equal((await listHarnessSessions(project)).length, 1);
  // An earlier watcher batch can arrive after atomic fork publication but before
  // the fork endpoint's final listing, without containing the fork's file event.
  await writeFile(`${forkPath}.tmp`, contents);
  await rename(`${forkPath}.tmp`, forkPath);
  await refreshHarnessSessions(project.id, [sourcePath]);
  await ensureConversationRecord(project.id, "claude", forkId, "fixture-node");
  const cached = (await listHarnessSessions(project)).find((session) => session.id === forkId)!;
  assert.equal(await readFile(forkPath, "utf8"), contents);
  clearHarnessSessionCache(project.id);
  const fresh = (await listHarnessSessions(project)).find((session) => session.id === forkId)!;
  assert.equal(fresh.path, `claude:${forkPath}`);
  assert.equal(cached.path, fresh.path, "Watcher refresh cached fork metadata without its transcript summary");
  assert.notEqual(cached.draft, true);
});

test("concurrent list discovers a file published while watcher summaries are pending", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "joint-bob-catalog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = { id: randomUUID(), name: "Catalog overlap", path: directory };
  const sourcePath = path.join(directory, "source.jsonl"), forkPath = path.join(directory, "fork.jsonl");
  await writeFile(sourcePath, "source");
  const summary = (filePath: string): SessionSummary => ({
    id: path.basename(filePath), path: filePath, harnessId: "pi", agentId: "pi", agentLabel: "Pi", title: filePath,
  });
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  let refreshCount = 0;
  const adapter = defineHarness({
    id: "pi", label: "Pi",
    paths: { newSession: "new", ownsSession: () => true, ownsTranscript: (filePath) => filePath.startsWith(`${directory}/`) },
    sessions: {
      files: async () => readdirSync(directory).map((file) => path.join(directory, file)),
      list: async () => [summary(sourcePath)],
      refresh: async (_project, previous, files) => {
        const changed = new Set(files);
        const sessions = [...previous.filter((session) => !changed.has(session.path)), ...files.map(summary)];
        if (++refreshCount === 1) {
          // Publish during summary refresh, after its input files were chosen.
          // Synchronous publication makes the old post-refresh snapshot observe it.
          writeFileSync(forkPath, "fork");
          started.resolve();
          await release.promise;
        }
        return sessions;
      },
      loadMessages: async () => [],
    },
  });
  const catalog = new HarnessSessionCatalog([adapter]);
  assert.deepEqual((await catalog.list(project)).map((session) => session.path), [sourcePath]);
  const refreshing = catalog.refresh(project.id, [sourcePath]);
  await started.promise;
  const listing = catalog.list(project);
  release.resolve();
  await refreshing;
  assert.deepEqual((await listing).map((session) => session.path).sort(), [sourcePath, forkPath].sort());
  assert.deepEqual((await catalog.list(project)).map((session) => session.path).sort(), [sourcePath, forkPath].sort());
});
