import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  cleanTopic, deleteTopic, diffLines, editChange, ensureMemorySchema, keepChange, lastRead, linkedFrom, listChanges, listTopics, memoryRoot, MemoryError,
  parseTopic, rankTopics, readTopic, recordRead, revertChange, searchTopics, topicHistory, topicLinks, topicText, waitingChanges, writeTopic,
  type ChangeMeta, type MemoryContext,
} from "../src/control-center/memory-store.js";

const BOB: ChangeMeta = { author: "bob", why: "You corrected Bob twice", source: { kind: "chat", text: "plan, then I approve", messageId: "m1", conversationId: null, projectId: "jb", projectName: "Joint Bob" } };
const YOU: ChangeMeta = { author: "person", why: "You edited this topic", source: { kind: "person", text: "", messageId: null, conversationId: null, projectId: null, projectName: null } };

async function memory(accountId = "ilia"): Promise<{ ctx: MemoryContext; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-memory-"));
  const db = new DatabaseSync(":memory:");
  ensureMemorySchema(db);
  ensureMemorySchema(db);
  return { ctx: { db, accountId, root }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const topic = (name: string, description: string, body: string, project: string | null = null) => cleanTopic(name, { description, body, project });

test("a topic is a markdown file with front matter that reads back the same, and the index lists every topic", async (t) => {
  const { ctx, cleanup } = await memory();
  t.after(cleanup);
  const gate = topic("release-gate", "Pushes need the token;\nfirst push is blocked once", "Push with the iliagerman token.\n\nRelated: [[how-ilia-works]] and [[how-ilia-works]] again.", "jb");
  assert.equal(gate.description, "Pushes need the token; first push is blocked once", "a description is one line");
  assert.deepEqual(topicLinks(gate.body), ["how-ilia-works"]);
  assert.deepEqual(parseTopic("release-gate", topicText(gate)), gate);

  writeTopic(ctx, gate, YOU);
  writeTopic(ctx, topic("how-ilia-works", "Plans first, approves plans himself", "Plans before building."), YOU);
  const file = readFileSync(path.join(ctx.root, "release-gate.md"), "utf8");
  assert.match(file, /^---\nname: release-gate\ndescription: Pushes need the token; first push is blocked once\nproject: jb\n---\n\nPush with/);
  assert.equal(readFileSync(path.join(ctx.root, "INDEX.md"), "utf8"), "# Bob's memory\n\n- [[how-ilia-works]] — Plans first, approves plans himself\n- [[release-gate]] — Pushes need the token; first push is blocked once\n");
  assert.deepEqual(listTopics(ctx.root).map((entry) => entry.name).sort(), ["how-ilia-works", "release-gate"]);
  assert.deepEqual(linkedFrom(listTopics(ctx.root), "how-ilia-works"), ["release-gate"]);

  // A file edited by hand with broken front matter still reads as a topic, and the index heals on the next write.
  writeFileSync(path.join(ctx.root, "how-ilia-works.md"), "Just some text.\n");
  assert.deepEqual(readTopic(ctx.root, "how-ilia-works"), { name: "how-ilia-works", description: "", project: null, body: "Just some text.", updatedAt: readTopic(ctx.root, "how-ilia-works")!.updatedAt });
  writeTopic(ctx, topic("mobile-ui", "Menu favourites", "Mark done, note, new conversation."), YOU);
  assert.match(readFileSync(path.join(ctx.root, "INDEX.md"), "utf8"), /- \[\[mobile-ui\]\] — Menu favourites/);
});

test("a topic needs a safe name, one line and some text", () => {
  for (const name of ["Bad Name", "../escape", "", "x".repeat(61), "-leading"]) assert.throws(() => cleanTopic(name, { description: "d", body: "b" }), (error) => error instanceof MemoryError && error.status === 400, name);
  assert.throws(() => cleanTopic("ok", { description: "  ", body: "b" }), /one-line description/);
  assert.throws(() => cleanTopic("ok", { description: "d", body: "  " }), /some text/);
  assert.throws(() => cleanTopic("ok", { description: "d".repeat(201), body: "b" }), /longer than 200/);
  assert.throws(() => cleanTopic("ok", { description: "d", body: "b", project: "../x" }), /Invalid project/);
});

test("each account has its own folder under the data directory, apart from any project's knowledge", () => {
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = path.join(os.tmpdir(), "joint-bob-memory-root");
  try {
    const mine = memoryRoot("a".repeat(32));
    assert.equal(mine, path.join(os.tmpdir(), "joint-bob-memory-root", "control-center", "memory", "a".repeat(32)));
    assert.notEqual(mine, memoryRoot("b".repeat(32)));
    assert.match(memoryRoot("../../etc"), /control-center\/memory\/[A-Za-z0-9_-]+$/, "an odd account id cannot leave the folder");
    assert.ok(!mine.includes(".agents"));
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
  }
});

test("a write records what changed, why and what taught Bob; the same text again changes nothing", async (t) => {
  const { ctx, cleanup } = await memory();
  t.after(cleanup);
  const created = writeTopic(ctx, topic("how-ilia-works", "Plans first", "Plans before building."), BOB)!;
  assert.equal(created.kind, "create");
  assert.equal(created.status, "applied", "Bob's write is on disk and waits for a look");
  assert.deepEqual(created.diff.map((line) => `${line.type}:${line.text}`), ["add:description: Plans first", "add:Plans before building."]);
  assert.deepEqual(created.source, BOB.source);
  assert.equal(writeTopic(ctx, topic("how-ilia-works", "Plans first", "Plans before building."), BOB), null);

  const updated = writeTopic(ctx, topic("how-ilia-works", "Plans first", "Plans before building.\nThe person approves plans himself."), BOB)!;
  assert.equal(updated.kind, "update");
  assert.deepEqual(updated.diff, [{ type: "add", text: "The person approves plans himself." }]);

  const person = writeTopic(ctx, topic("how-ilia-works", "Plans first", "Plans before building."), YOU)!;
  assert.equal(person.status, "kept", "the person's own edit needs no review");
  assert.deepEqual(person.diff, [{ type: "del", text: "The person approves plans himself." }]);
  assert.deepEqual(topicHistory(ctx, "how-ilia-works").map((entry) => [entry.author, entry.kind, entry.status]), [["person", "update", "kept"], ["bob", "update", "applied"], ["bob", "create", "applied"]]);
  assert.equal(waitingChanges(ctx), 2);
  assert.deepEqual(listChanges(ctx, 0, 2).changes.map((change) => change.id), [person.id, updated.id]);
  assert.equal(listChanges(ctx, 2, 5).changes.length, 1);
  assert.equal(listChanges(ctx, 0, 1).total, 3);
});

test("with ask-first a change waits as pending, the topic is untouched, and keeping it writes the topic", async (t) => {
  const { ctx, cleanup } = await memory();
  t.after(cleanup);
  writeTopic(ctx, topic("mobile-ui", "Menu", "Mark done."), YOU);
  const pending = writeTopic(ctx, topic("mobile-ui", "Menu", "Mark done.\nTools and Costs are out."), BOB, true)!;
  assert.equal(pending.status, "pending");
  assert.equal(readTopic(ctx.root, "mobile-ui")!.body, "Mark done.");
  assert.equal(waitingChanges(ctx), 1);

  // The topic changes while the proposal waits: the later write wins and the history shows what it replaced.
  writeTopic(ctx, topic("mobile-ui", "Menu", "Mark done. Settings never scroll sideways."), YOU);
  const kept = keepChange(ctx, pending.id);
  assert.equal(kept.status, "kept");
  assert.equal(readTopic(ctx.root, "mobile-ui")!.body, "Mark done.\nTools and Costs are out.");
  assert.deepEqual(kept.diff.map((line) => `${line.type}:${line.text}`), ["del:Mark done. Settings never scroll sideways.", "add:Mark done.", "add:Tools and Costs are out."]);
  assert.throws(() => keepChange(ctx, pending.id), (error) => error instanceof MemoryError && error.status === 409);
  assert.equal(waitingChanges(ctx), 0);
});

test("keeping a change Bob already wrote just marks it kept", async (t) => {
  const { ctx, cleanup } = await memory();
  t.after(cleanup);
  const change = writeTopic(ctx, topic("a-topic", "One", "Text."), BOB)!;
  assert.equal(keepChange(ctx, change.id).status, "kept");
  assert.equal(readTopic(ctx.root, "a-topic")!.body, "Text.");
});

test("reverting restores the earlier text, removes a topic the change created, and drops a waiting proposal", async (t) => {
  const { ctx, cleanup } = await memory();
  t.after(cleanup);
  writeTopic(ctx, topic("dak-live-slices", "Slices", "Slice 7 is Matan's."), YOU);
  const update = writeTopic(ctx, topic("dak-live-slices", "Slices", "Slice 7 is on the Mac."), BOB)!;
  const reverted = revertChange(ctx, update.id);
  assert.equal(reverted.status, "reverted");
  assert.equal(readTopic(ctx.root, "dak-live-slices")!.body, "Slice 7 is Matan's.");
  assert.throws(() => revertChange(ctx, update.id), (error) => error instanceof MemoryError && error.status === 409);
  assert.equal(listChanges(ctx, 0, 10).total, 2, "nothing extra is recorded when the topic was still as the change left it");

  const created = writeTopic(ctx, topic("automations", "Reports", "07:00 on the homeserver."), BOB)!;
  revertChange(ctx, created.id);
  assert.equal(existsSync(path.join(ctx.root, "automations.md")), false);
  assert.doesNotMatch(readFileSync(path.join(ctx.root, "INDEX.md"), "utf8"), /automations/);

  const proposal = writeTopic(ctx, topic("ideas", "Ideas", "Some."), BOB, true)!;
  assert.equal(revertChange(ctx, proposal.id).status, "reverted");
  assert.equal(existsSync(path.join(ctx.root, "ideas.md")), false, "a dropped proposal never reached the disk");
  assert.throws(() => keepChange(ctx, proposal.id), (error) => error instanceof MemoryError && error.status === 409);
});

test("reverting an older change after the topic moved on restores its text and records the restore, so no text is lost", async (t) => {
  const { ctx, cleanup } = await memory();
  t.after(cleanup);
  const first = writeTopic(ctx, topic("x-topic", "X", "One."), BOB)!;
  writeTopic(ctx, topic("x-topic", "X", "One.\nTwo."), YOU);
  revertChange(ctx, first.id);
  assert.equal(existsSync(path.join(ctx.root, "x-topic.md")), false);
  const history = listChanges(ctx, 0, 10).changes;
  assert.equal(history.length, 3);
  assert.equal(history[0].kind, "delete");
  assert.match(history[0].why, /Reverted an earlier change/);
  assert.deepEqual(history[0].diff.filter((line) => line.type === "del").map((line) => line.text), ["description: X", "One.", "Two."], "the text the revert removed stays in the history");
  // Reverting the restore brings the topic back as it was.
  revertChange(ctx, history[0].id);
  assert.equal(readTopic(ctx.root, "x-topic")!.body, "One.\nTwo.");
});

test("the person can edit a waiting proposal before keeping it, and edit what Bob wrote as a change of their own", async (t) => {
  const { ctx, cleanup } = await memory();
  t.after(cleanup);
  const proposal = writeTopic(ctx, topic("how-ilia-works", "Plans first", "Plans first and builds right away."), BOB, true)!;
  const edited = editChange(ctx, proposal.id, { description: "Plans first", body: "Plans first and approves plans himself." }, "You edited what Bob saved");
  assert.equal(edited.status, "kept");
  assert.equal(edited.edited, true, "the change shows the person edited Bob's proposal");
  assert.equal(readTopic(ctx.root, "how-ilia-works")!.body, "Plans first and approves plans himself.");

  const written = writeTopic(ctx, topic("how-ilia-works", "Plans first", "Plans first, approves plans himself, no worktrees."), BOB)!;
  const keptAfterEdit = editChange(ctx, written.id, { description: "Plans first", body: "Plans first, approves plans himself." }, "You edited what Bob saved");
  assert.equal(keptAfterEdit.status, "kept");
  const latest = listChanges(ctx, 0, 1).changes[0];
  assert.equal(latest.author, "person", "the person's edit is a change in its own right");
  assert.deepEqual(latest.diff, [{ type: "del", text: "Plans first, approves plans himself, no worktrees." }, { type: "add", text: "Plans first, approves plans himself." }]);
  assert.throws(() => editChange(ctx, written.id, { description: "d", body: "b" }, "x"), (error) => error instanceof MemoryError && error.status === 409);
});

test("deleting a topic is a change that can be reverted, and removes it from the index", async (t) => {
  const { ctx, cleanup } = await memory();
  t.after(cleanup);
  writeTopic(ctx, topic("old-notes", "Old", "Old text."), YOU);
  const deleted = deleteTopic(ctx, "old-notes", { ...YOU, why: "You deleted this topic" });
  assert.equal(deleted.kind, "delete");
  assert.equal(readTopic(ctx.root, "old-notes"), null);
  assert.throws(() => deleteTopic(ctx, "old-notes", YOU), (error) => error instanceof MemoryError && error.status === 404);
  revertChange(ctx, deleted.id);
  assert.equal(readTopic(ctx.root, "old-notes")!.body, "Old text.");
  assert.match(readFileSync(path.join(ctx.root, "INDEX.md"), "utf8"), /old-notes/);
});

test("one account's changes and reads are not another's", async (t) => {
  const { ctx, cleanup } = await memory("ilia");
  t.after(cleanup);
  const other: MemoryContext = { ...ctx, accountId: "someone-else" };
  const change = writeTopic(ctx, topic("mine", "Mine", "Text."), BOB)!;
  recordRead(ctx, ["mine"], "a question");
  assert.equal(listChanges(other, 0, 10).total, 0);
  assert.equal(lastRead(other), null);
  assert.throws(() => keepChange(other, change.id), (error) => error instanceof MemoryError && error.status === 404);
  assert.deepEqual(lastRead(ctx)!.topics, ["mine"]);
  recordRead(ctx, [], "next question");
  assert.deepEqual(lastRead(ctx), { topics: [], message: "next question", at: lastRead(ctx)!.at });
});

test("search ranks name, then description, then text; the diff keeps only changed lines", () => {
  const topics = [
    topic("mobile-ui", "Menu favourites", "Mark done, note, new conversation."),
    topic("release-gate", "Pushes need the token", "The release gate blocks the first push once. Menu is unrelated."),
    topic("homeserver-ops", "Cleanup crons and deploy retries", "Pruning of backups."),
  ];
  assert.deepEqual(searchTopics(topics, "release push").map((entry) => entry.name), ["release-gate"]);
  assert.deepEqual(searchTopics(topics, "menu").map((entry) => entry.name), ["mobile-ui", "release-gate"]);
  assert.deepEqual(searchTopics(topics, "zzz"), []);
  assert.equal(rankTopics(topics, "the and for").every((entry) => entry.score === 0), true, "common words match nothing");

  assert.deepEqual(diffLines("a\nb\nc", "a\nB\nc"), [{ type: "del", text: "b" }, { type: "add", text: "B" }]);
  assert.deepEqual(diffLines("", "x\n\ny"), [{ type: "add", text: "x" }, { type: "add", text: "y" }]);
  assert.deepEqual(diffLines("same", "same"), []);
});
