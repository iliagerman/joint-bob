import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { internalSessionId, isInternalSession } from "../src/internal-sessions.js";
import { syncResolverPrompt } from "../src/server/sync-check.js";
import { updateSettings } from "../src/settings.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { clearHarnessSessionCache, listHarnessSessions } from "../src/harnesses.js";
import { listPiSessions, refreshPiSessions } from "../src/pi-service.js";
import { listClaudeSessions, refreshClaudeSessions } from "../src/claude-service.js";
import { claudeProjectDir } from "../src/session-paths.js";
import { initializeKiroSession, appendKiroRecord, listKiroSessions, refreshKiroSessions } from "../src/harnesses/kiro/storage.js";

test("internal IDs remain native UUIDs and legacy detection does not hide discussions of the fixer", () => {
  const id = internalSessionId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(id, internalSessionId());
  assert.ok(isInternalSession(id));
  assert.ok(isInternalSession(randomUUID(), syncResolverPrompt([])));
  assert.equal(isInternalSession(randomUUID(), "Please fix this prompt: " + syncResolverPrompt([])), false);
});

test("all harness listings hide new, empty and legacy fixer sessions, including renamed and refreshed transcripts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "internal-sessions-"));
  try {
    const cwd = path.join(root, "project");
    const piRoot = path.join(root, "pi");
    const claudeRoot = path.join(root, "claude");
    updateSettings({
      syncthing: { endpoint: "" },
      pi: { executable: "", configPath: piRoot, sessionPath: piRoot },
      claude: { executable: "", configPath: claudeRoot, sessionPath: claudeRoot },
    });
    const project = { id: "internal-test", path: cwd };
    const piDir = path.join(piRoot, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
    const claudeDir = claudeProjectDir(cwd, claudeRoot);
    await mkdir(piDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    const visibleId = randomUUID();
    const cases = [
      { id: visibleId, text: "Normal user conversation" },
      { id: internalSessionId(), text: "Repair files" },
      { id: internalSessionId(), text: "" },
      { id: randomUUID(), text: syncResolverPrompt([]) },
    ];
    const piFiles: string[] = [], claudeFiles: string[] = [], kiroFiles: string[] = [];
    const timestamp = new Date().toISOString();
    for (const { id, text } of cases) {
      const piFile = path.join(piDir, `${id}.jsonl`);
      const claudeFile = path.join(claudeDir, `${id}.jsonl`);
      const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
      await writeFile(piFile, jsonl([
        { type: "session", version: 3, id, cwd, timestamp },
        { type: "message", message: { role: "user", content: text }, timestamp },
        { type: "session_info", name: "Renamed" },
      ]));
      await writeFile(claudeFile, jsonl([
        { type: "user", cwd, message: { role: "user", content: text }, timestamp },
        { type: "custom-title", customTitle: "Renamed" },
      ]));
      const kiroFile = await initializeKiroSession({ projectId: project.id, cwd, sessionId: id }, { provider: "kiro", modelId: "test", reasoning: "default" });
      if (text) await appendKiroRecord(kiroFile, { type: "message", role: "user", text, timestamp });
      await appendKiroRecord(kiroFile, { type: "title", title: "Renamed", timestamp });
      piFiles.push(piFile); claudeFiles.push(claudeFile); kiroFiles.push(kiroFile);
      // Legacy fixer runs predate internal IDs; their records were deleted once, so only transcripts remain.
      if (isInternalSession(id) || !isInternalSession(id, text)) for (const engine of ["pi", "claude", "kiro"]) await ensureConversationRecord(project.id, engine, id, "test-node");
    }
    for (const [list, refresh, files] of [
      [listPiSessions, refreshPiSessions, piFiles],
      [listClaudeSessions, refreshClaudeSessions, claudeFiles],
      [listKiroSessions, refreshKiroSessions, kiroFiles],
    ] as const) {
      assert.deepEqual((await list(project)).map((session) => session.id), [visibleId]);
      assert.deepEqual((await refresh(project, [], files)).map((session) => session.id), [visibleId]);
    }
    clearHarnessSessionCache(project.id);
    const catalog = await listHarnessSessions(project, [...piFiles, ...claudeFiles, ...kiroFiles]);
    assert.equal(catalog.length, 1, "only the normal conversation remains after same-ID segments are grouped");
    assert.ok(catalog.every((session) => session.id === visibleId));
    await Promise.all(kiroFiles.map((file) => rm(file, { force: true })));
  } finally { await rm(root, { recursive: true, force: true }); }
});
