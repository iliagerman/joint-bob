import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("conversation records provide drafts until a transcript replaces them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-conversation-records-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const project = { id: "project", name: "Project", path: path.join(root, "project"), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  try {
    const records = await import(`../src/conversation-records.ts?test=${Date.now()}`);
    const first = await records.ensureConversationRecord(project.id, "pi", id);
    const second = await records.ensureConversationRecord(project.id, "pi", id);
    assert.equal((await records.listConversationRecords(project.id)).length, 1);
    assert.equal((await records.getConversationRecord(project.id, "pi", id))?.sessionId, id);
    assert.ok(second.updatedAt >= first.updatedAt);
    assert.deepEqual(records.parseConversationDraftPath(`draft:pi:${id}`), { engine: "pi", sessionId: id });
    assert.equal(records.parseConversationDraftPath("draft:pi:not-a-uuid"), undefined);
    assert.equal(records.parseConversationDraftPath("draft:other:123e4567-e89b-42d3-a456-426614174000"), undefined);

    const { updateSettings } = await import("../src/settings.js");
    const sessionPath = path.join(root, "sessions");
    updateSettings({ pi: { executable: "", configPath: path.join(root, "pi"), sessionPath }, claude: { executable: "", configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") }, syncthing: { endpoint: "" }, projects: { homePath: path.join(root, "home") } });
    const { listHarnessSessions } = await import("../src/harnesses.js");
    assert.equal((await listHarnessSessions(project)).filter((session) => session.id === id).length, 1);
    assert.ok((await listHarnessSessions(project)).some((session) => session.path === `draft:pi:${id}`));

    await mkdir(sessionPath, { recursive: true });
    await writeFile(path.join(sessionPath, `${id}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: project.path })}\n${JSON.stringify({ type: "message", id: "message", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } })}\n`);
    const merged = (await listHarnessSessions(project)).filter((session) => session.id === id);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].draft, undefined);
    assert.equal(await records.deleteConversationRecord(project.id, "pi", id), true);
    assert.equal(await records.getConversationRecord(project.id, "pi", id), undefined);
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR; else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
