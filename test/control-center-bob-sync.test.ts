import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyBobEvent, applyBobMessageEvent, applyReviewCheckEvent, backfillChat, publishBobAccount, publishBobMessage, publishReviewCheck } from "../src/control-center/bob-sync.js";
import { registerBobAction, runBobAction, setRemoteBobAction } from "../src/control-center/bob-actions.js";
import { appendBobMessage, bobMessageOrigin, clearBobActions, ensureBobSchema, getBobMessage, listBobAccounts, listBobMessages, onBobMessageWritten, readBobSettings, resolveBobMessage, storeBobSettings, type BobMessage } from "../src/control-center/bob-store.js";
import type { AuthSession } from "../src/auth.js";
import { readReviewCheck, type ReviewCheck } from "../src/control-center/review-check.js";
import { ensureReplicationSchema, type ReplicationEvent } from "../src/replication.js";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";

function machine(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureReplicationSchema(db);
  ensureBobSchema(db);
  return db;
}

/** What one machine sent, as the other receives it. */
function sent(db: DatabaseSync): ReplicationEvent[] {
  return (db.prepare("SELECT * FROM replication_outbox ORDER BY created_at, rowid").all() as Array<Record<string, string>>).map((row) => ({
    id: row.event_id, originNodeId: row.origin_node_id, entityType: row.entity_type, entityKey: row.entity_key, operation: row.operation, payload: JSON.parse(row.payload), createdAt: row.created_at,
  }));
}

const check = (overrides: Partial<ReviewCheck> = {}): ReviewCheck => ({
  projectId: "mac-project", conversationId: "c1", accountId: ACCOUNT, verdict: "needs-user", reason: "It asks for the Stripe key.", by: "Decision model 95%",
  answerHash: "h1", pushes: 0, pushPending: false, needsYou: true, checkedAt: "2026-11-06T10:00:00.000Z", ...overrides,
});

test("a person who uses Bob on one machine is a Bob user on their other machine, with the settings they chose, and the newest settings win", () => {
  const mac = machine();
  const server = machine();
  storeBobSettings(mac, ACCOUNT, { monitoring: false, reviewCheck: "ask" }, "2026-11-06T09:00:00.000Z");
  publishBobAccount(mac, "mac", ACCOUNT);
  for (const event of sent(mac)) applyBobEvent(server, event);
  assert.deepEqual(listBobAccounts(server).map((actor) => actor.accountId), [ACCOUNT]);
  assert.equal(readBobSettings(server, ACCOUNT).monitoring, false, "paused on one machine is paused on the other");
  assert.equal(readBobSettings(server, ACCOUNT).reviewCheck, "ask");

  // A later change on the server is not undone by the Mac's older settings arriving again.
  storeBobSettings(server, ACCOUNT, { monitoring: true, reviewCheck: "push" }, "2026-11-06T11:00:00.000Z");
  for (const event of sent(mac)) applyBobEvent(server, event);
  assert.equal(readBobSettings(server, ACCOUNT).monitoring, true);
  assert.throws(() => applyBobEvent(server, { ...sent(mac)[0], entityKey: "someone-else" }), /Malformed/);
});

test("what a check found reaches the person's other machine under that machine's id for the project, and an older check does not replace a newer one", () => {
  const mac = machine();
  const server = machine();
  server.exec("CREATE TABLE project_aliases (alias_id TEXT PRIMARY KEY, project_id TEXT NOT NULL); INSERT INTO project_aliases VALUES ('mac-project', 'server-project')");
  publishReviewCheck(mac, "mac", check());
  for (const event of sent(mac)) applyReviewCheckEvent(server, event);
  assert.deepEqual(readReviewCheck(server, "server-project", "c1"), check({ projectId: "server-project" }));

  publishReviewCheck(mac, "mac", check({ verdict: "done", needsYou: false, checkedAt: "2026-11-06T09:00:00.000Z" }));
  for (const event of sent(mac)) applyReviewCheckEvent(server, event);
  assert.equal(readReviewCheck(server, "server-project", "c1")?.verdict, "needs-user", "the newer check stays");
  assert.throws(() => applyReviewCheckEvent(server, { ...sent(mac)[0], payload: { ...check(), verdict: "maybe" } }), /Malformed/);
});

test("the person's chat with Bob reaches their other machine, buttons included, and a press there takes the buttons off everywhere", () => {
  const mac = machine();
  const server = machine();
  server.exec("CREATE TABLE project_aliases (alias_id TEXT PRIMARY KEY, project_id TEXT NOT NULL); INSERT INTO project_aliases VALUES ('mac-project', 'server-project')");
  const written: Array<{ id: string; updatedAt: string }> = [];
  const stop = onBobMessageWritten((accountId, message, updatedAt) => { written.push({ id: message.id, updatedAt }); publishBobMessage(mac, "mac", accountId, message, updatedAt); });
  try {
    appendBobMessage(mac, ACCOUNT, { role: "user", text: "what waits for me?" });
    const ask = appendBobMessage(mac, ACCOUNT, { role: "bob", text: "Create the evening report?", importance: "needs-you", projectId: "mac-project", projectName: "Joint Bob", actions: [{ id: "automations.create", label: "Create it", style: "primary" }] });
    for (const event of sent(mac)) applyBobMessageEvent(server, event);
    const there = listBobMessages(server, ACCOUNT);
    assert.deepEqual(there.map((message) => message.text), ["what waits for me?", "Create the evening report?"], "the same chat, in the same order");
    assert.equal(there[1].projectId, "server-project", "labelled with that machine's id for the project");
    assert.equal(bobMessageOrigin(server, ACCOUNT, ask.id), "mac", "it remembers which machine wrote it");
    assert.equal(bobMessageOrigin(mac, ACCOUNT, ask.id), null);

    // Pressed on the Mac: the buttons go, and the newer copy replaces the server's, even within the millisecond it was written.
    mac.prepare("UPDATE control_center_bob_messages SET updated_at = ? WHERE id = ?").run(new Date(Date.now() + 60_000).toISOString(), ask.id);
    clearBobActions(mac, ACCOUNT, ask.id);
    assert.ok(written.at(-1)!.updatedAt > new Date(Date.now() + 59_000).toISOString(), "a change is always newer than the copy before it");
    for (const event of sent(mac)) applyBobMessageEvent(server, event);
    assert.deepEqual(getBobMessage(server, ACCOUNT, ask.id)?.actions, []);
    // An older copy arriving late does not bring them back.
    const stale = sent(mac).find((event) => event.entityKey === `${ACCOUNT}:${ask.id}` && (event.payload as { message: { actions: unknown[] } }).message.actions.length)!;
    applyBobMessageEvent(server, stale);
    assert.deepEqual(getBobMessage(server, ACCOUNT, ask.id)?.actions, []);
    assert.equal(written.length, 3, "each write on the Mac is sent once; nothing the server received is sent on");

    // Cleared on the Mac: the server's copy is cleared too, with why. A machine on an older version sends no cleared state.
    resolveBobMessage(mac, ACCOUNT, ask.id, "You looked at it.");
    for (const event of sent(mac)) applyBobMessageEvent(server, event);
    assert.deepEqual([getBobMessage(server, ACCOUNT, ask.id)?.resolution, Boolean(getBobMessage(server, ACCOUNT, ask.id)?.resolvedAt)], ["You looked at it.", true]);
    const { resolvedAt: _at, resolution: _why, ...older } = (stale.payload as { message: BobMessage }).message;
    applyBobMessageEvent(server, { ...stale, entityKey: `${ACCOUNT}:older`, payload: { ...(stale.payload as object), message: { ...older, id: "older" } } });
    assert.equal(getBobMessage(server, ACCOUNT, "older")?.resolvedAt, null);
    assert.throws(() => applyBobMessageEvent(server, { ...stale, payload: { ...(stale.payload as object), message: { ...older, resolvedAt: "soon", resolution: "x" } } }), /Malformed/);
    assert.throws(() => applyBobMessageEvent(server, { ...stale, payload: { ...(stale.payload as object), message: { ...(stale.payload as { message: object }).message, role: "root" } } }), /Malformed/);
  } finally { stop(); }
});

test("a button on a message from the person's other machine is pressed on that machine, not here", async () => {
  const db = machine();
  const session = { accountId: ACCOUNT } as AuthSession;
  const ran: string[] = [];
  registerBobAction("test.sync.local", async () => { ran.push("local"); });
  const forwarded: Array<[string, string, string]> = [];
  setRemoteBobAction(async (origin, _accountId, messageId, actionId) => { forwarded.push([origin, messageId, actionId]); return []; });
  const local = appendBobMessage(db, ACCOUNT, { role: "bob", text: "here", actions: [{ id: "test.sync.local", label: "Go" }] });
  await runBobAction(db, session, local.id, "test.sync.local");
  assert.deepEqual(ran, ["local"]);
  const other = machine();
  const remote = appendBobMessage(other, ACCOUNT, { role: "bob", text: "there", actions: [{ id: "test.sync.local", label: "Go" }] });
  publishBobMessage(other, "server", ACCOUNT, remote, remote.createdAt);
  for (const event of sent(other)) applyBobMessageEvent(db, event);
  await runBobAction(db, session, remote.id, "test.sync.local");
  assert.deepEqual(forwarded, [["server", remote.id, "test.sync.local"]]);
  assert.deepEqual(ran, ["local"], "nothing ran here for the other machine's message");
});

test("the chat written before it followed the person is sent to their other machine once, and messages that came from elsewhere are not sent back", () => {
  const mac = machine();
  const server = machine();
  const older = appendBobMessage(mac, ACCOUNT, { role: "user", text: "an older question" });
  const elsewhere = machine();
  const theirs = appendBobMessage(elsewhere, ACCOUNT, { role: "bob", text: "from a third machine" });
  publishBobMessage(elsewhere, "laptop", ACCOUNT, theirs, theirs.createdAt);
  for (const event of sent(elsewhere)) applyBobMessageEvent(mac, event);
  mac.exec("DELETE FROM replication_outbox");
  backfillChat(mac, "mac", ACCOUNT);
  backfillChat(mac, "mac", ACCOUNT);
  assert.deepEqual(sent(mac).map((event) => event.entityKey), [`${ACCOUNT}:${older.id}`], "once, and only what this machine wrote");
  for (const event of sent(mac)) applyBobMessageEvent(server, event);
  assert.deepEqual(listBobMessages(server, ACCOUNT).map((message) => message.text), ["an older question"]);
});
