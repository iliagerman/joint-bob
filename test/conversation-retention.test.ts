import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EMPTY_CONVERSATION_GRACE_MS, UNOWNED_EMPTY_CONVERSATION_GRACE_MS, retentionReason, type RetentionContext } from "../src/conversation-retention.js";
import type { SessionSummary } from "../src/types.js";

const DAY = 86_400_000;
const now = Date.parse("2026-09-30T12:00:00Z");
const ago = (ms: number): string => new Date(now - ms).toISOString();
const session = (overrides: Partial<SessionSummary>): SessionSummary => ({
  id: randomUUID(), path: "claude:/tmp/x.jsonl", harnessId: "claude", agentId: "claude", agentLabel: "Claude", title: "t", ...overrides,
});
const context = (overrides: Partial<RetentionContext> = {}): RetentionContext => ({
  now, retentionDays: 40, pinned: new Set(), ownedLocally: () => true, hasQueuedPrompts: () => false, ...overrides,
});

test("conversations idle past the retention days expire; newer ones stay", () => {
  assert.equal(retentionReason(session({ updatedAt: ago(41 * DAY) }), context()), "expired");
  assert.equal(retentionReason(session({ updatedAt: ago(39 * DAY) }), context()), undefined);
  assert.equal(retentionReason(session({ updatedAt: ago(41 * DAY) }), context({ retentionDays: 60 })), undefined);
});

test("empty conversations go after the grace period, unowned ones only after a week", () => {
  const draft = (age: number) => session({ draft: true, path: "draft:claude:x", updatedAt: ago(age) });
  assert.equal(retentionReason(draft(EMPTY_CONVERSATION_GRACE_MS + 1), context()), "empty");
  assert.equal(retentionReason(draft(EMPTY_CONVERSATION_GRACE_MS - 1000), context()), undefined);
  assert.equal(retentionReason(draft(2 * EMPTY_CONVERSATION_GRACE_MS), context({ ownedLocally: () => undefined })), undefined);
  assert.equal(retentionReason(draft(UNOWNED_EMPTY_CONVERSATION_GRACE_MS + 1), context({ ownedLocally: () => undefined })), "empty");
  assert.equal(retentionReason(draft(2 * EMPTY_CONVERSATION_GRACE_MS), context({ hasQueuedPrompts: () => true })), undefined);
});

test("a switched conversation with a started segment is not empty", () => {
  const face = session({ draft: true, updatedAt: ago(2 * EMPTY_CONVERSATION_GRACE_MS), segments: [
    { engine: "pi", sessionId: randomUUID(), path: "pi:/tmp/a.jsonl" }, { engine: "claude", sessionId: randomUUID(), path: "draft:claude:b", draft: true },
  ] });
  assert.equal(retentionReason(face, context()), undefined);
});

test("pinned, ticket, scheduled, read-only and peer-owned conversations are never deleted", () => {
  const old = { updatedAt: ago(100 * DAY) };
  const pinned = session(old);
  assert.equal(retentionReason(pinned, context({ pinned: new Set([`claude:${pinned.id}`]) })), undefined);
  const byPath = session({ ...old, path: "claude:/tmp/pinned.jsonl" });
  assert.equal(retentionReason(byPath, context({ pinned: new Set(["claude:/tmp/pinned.jsonl"]) })), undefined);
  const segmentId = randomUUID();
  const switched = session({ ...old, segments: [{ engine: "pi", sessionId: segmentId, path: "pi:/tmp/s.jsonl" }] });
  assert.equal(retentionReason(switched, context({ pinned: new Set([`pi:${segmentId}`]) })), undefined);
  assert.equal(retentionReason(session({ ...old, taskId: "t" }), context()), undefined);
  assert.equal(retentionReason(session({ ...old, cronTaskId: "c" }), context()), undefined);
  assert.equal(retentionReason(session({ ...old, readOnly: true }), context()), undefined);
  assert.equal(retentionReason(session(old), context({ ownedLocally: () => false })), undefined);
  assert.equal(retentionReason(session(old), context({ ownedLocally: () => undefined })), "expired");
});

test("the sweep deletes this node's expired and empty conversations and keeps the rest", { timeout: 60_000 }, async () => {
  const { resolveDataDirectory } = await import("../src/data-directory.js");
  const root = resolveDataDirectory();
  const sessionRoot = path.join(root, "claude-sessions");
  const projectPath = path.join(root, "retention-project");
  await mkdir(projectPath, { recursive: true });
  const settings = await import("../src/settings.js");
  settings.updateSettings({
    pi: { executable: "pi", configPath: path.join(root, "pi-config"), sessionPath: path.join(root, "pi-sessions") },
    claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: sessionRoot },
    syncthing: { endpoint: "" },
  });
  assert.equal(settings.getSettings().conversationRetentionDays, 40, "retention defaults to 40 days");
  const { addProject } = await import("../src/store.js");
  const { claudeProjectDir } = await import("../src/session-paths.js");
  const { getClusterNode } = await import("../src/cluster.js");
  const { ensureConversationRecord, deletedConversationKeys, listConversationRecords } = await import("../src/conversation-records.js");
  const { claimConversationOwnership } = await import("../src/conversation-ownership.js");
  const { setUserPin } = await import("../src/user-pins.js");
  const { sweepConversationRetention } = await import("../src/server/conversation-retention.js");
  const project = await addProject("Retention fixture", projectPath, { writeInstructions: false });
  const local = await getClusterNode();
  const directory = claudeProjectDir(projectPath, sessionRoot);
  await mkdir(directory, { recursive: true });
  const transcript = async (ageDays: number): Promise<{ id: string; file: string }> => {
    const id = randomUUID(), file = path.join(directory, `${id}.jsonl`), at = new Date(Date.now() - ageDays * DAY);
    await writeFile(file, JSON.stringify({ type: "user", uuid: randomUUID(), sessionId: id, cwd: projectPath, timestamp: at.toISOString(), message: { role: "user", content: `Conversation ${ageDays} days old` } }) + "\n");
    await utimes(file, at, at);
    return { id, file };
  };
  const expired = await transcript(45), recent = await transcript(5), pinned = await transcript(45);
  setUserPin("admin", { kind: "conversation", projectId: project.id, engine: "claude", sessionId: pinned.id }, true, local.id);

  const db = new DatabaseSync(path.join(root, "node.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const draft = async (ageMs: number, origin = local.id, owned = true): Promise<string> => {
    const id = randomUUID();
    await ensureConversationRecord(project.id, "claude", id, origin);
    if (owned) await claimConversationOwnership("claude", id, local.id);
    const at = new Date(Date.now() - ageMs).toISOString();
    db.prepare("UPDATE conversation_records SET created_at = ?, updated_at = ? WHERE project_id = ? AND session_id = ?").run(at, at, project.id, id);
    return id;
  };
  const staleDraft = await draft(2 * EMPTY_CONVERSATION_GRACE_MS);
  const freshDraft = await draft(60_000);
  const peerDraft = await draft(2 * EMPTY_CONVERSATION_GRACE_MS, randomUUID(), false);
  db.close();

  const { clearHarnessSessionCache } = await import("../src/harnesses.js");
  clearHarnessSessionCache(project.id);
  assert.equal(await sweepConversationRetention(), 2);
  const exists = (file: string) => access(file).then(() => true, () => false);
  assert.equal(await exists(expired.file), false, "the 45-day-old transcript is deleted");
  assert.equal(await exists(recent.file), true);
  assert.equal(await exists(pinned.file), true, "a pinned conversation is kept however old");
  const deleted = await deletedConversationKeys(project.id);
  assert.ok(deleted.has(`claude:${expired.id}`), "the deletion replicates as a tombstone");
  assert.ok(deleted.has(`claude:${staleDraft}`), "an hour-old empty conversation is deleted");
  const remaining = new Set((await listConversationRecords(project.id)).map((record) => record.sessionId));
  assert.ok(remaining.has(freshDraft), "a just-opened conversation is kept");
  assert.ok(remaining.has(peerDraft), "a draft another node created is left to that node");

  settings.updateSettings({ ...settings.getSettings(), syncthing: { endpoint: "" }, conversationRetentionDays: 60 });
  assert.equal(settings.getSettings().conversationRetentionDays, 60);
  const older = await transcript(50);
  clearHarnessSessionCache(project.id);
  assert.equal(await sweepConversationRetention(), 0, "a longer retention keeps a 50-day-old conversation");
  assert.equal(await exists(older.file), true);
  assert.throws(() => settings.updateSettings({ ...settings.getSettings(), syncthing: { endpoint: "" }, conversationRetentionDays: 0 }), /retention/);
});
