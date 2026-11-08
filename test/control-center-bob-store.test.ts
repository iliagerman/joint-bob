import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { appendBobMessage, countBobMessages, DEFAULT_BOB_SETTINGS, ensureBobSchema, listBobMessages, readBobSettings, writeBobSettings } from "../src/control-center/bob-store.js";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureBobSchema(db);
  ensureBobSchema(db);
  return db;
}

test("settings start at the defaults, change one field at a time and are cleaned", () => {
  const db = database();
  assert.deepEqual(readBobSettings(db, "ilia"), DEFAULT_BOB_SETTINGS);
  assert.equal(writeBobSettings(db, "ilia", { threshold: 0.8, harnessId: "pi" }).threshold, 0.8);
  assert.deepEqual({ ...readBobSettings(db, "ilia"), threshold: 0.8, harnessId: "pi" }, readBobSettings(db, "ilia"));
  // Nonsense falls back to the defaults instead of being stored.
  const cleaned = writeBobSettings(db, "ilia", { threshold: 7, classifier: "x" as never, monitoring: false });
  assert.equal(cleaned.threshold, DEFAULT_BOB_SETTINGS.threshold);
  assert.equal(cleaned.classifier, "typesafe");
  assert.equal(cleaned.monitoring, false);
  assert.equal(cleaned.harnessId, "pi", "earlier changes stay");
  assert.deepEqual(readBobSettings(db, "someone-else"), DEFAULT_BOB_SETTINGS, "one person's settings are not another's");
});

test("messages keep their order, labels and buttons, and filter by project and importance", () => {
  const db = database();
  appendBobMessage(db, "ilia", { role: "user", text: "what is running in dak?", projectId: "dak", projectName: "DAK Live" });
  appendBobMessage(db, "ilia", { role: "bob", text: "Two things.", via: "Decision model 97% · question", projectId: "dak", projectName: "DAK Live" });
  appendBobMessage(db, "ilia", { role: "system", text: "Prod 5xx at 14%", importance: "urgent", projectId: "julian", projectName: "Julian", actions: [{ id: "investigate", label: "Investigate (read-only)", style: "warn" }] });
  appendBobMessage(db, "ilia", { role: "bob", text: "Morning report", importance: "report" });
  appendBobMessage(db, "other", { role: "bob", text: "not yours" });

  const all = listBobMessages(db, "ilia");
  assert.deepEqual(all.map((message) => message.text), ["what is running in dak?", "Two things.", "Prod 5xx at 14%", "Morning report"]);
  assert.deepEqual(all[2].actions, [{ id: "investigate", label: "Investigate (read-only)", style: "warn" }]);
  assert.deepEqual(listBobMessages(db, "ilia", { project: "dak" }).map((message) => message.text), ["what is running in dak?", "Two things."]);
  assert.deepEqual(listBobMessages(db, "ilia", { project: "general" }).map((message) => message.text), ["Morning report"]);
  assert.deepEqual(listBobMessages(db, "ilia", { importance: "important" }).map((message) => message.text), ["Prod 5xx at 14%"]);
  assert.deepEqual(listBobMessages(db, "ilia", { importance: "reports" }).map((message) => message.text), ["Morning report"]);
  assert.deepEqual(listBobMessages(db, "ilia", { importance: "fyi" }).map((message) => message.text), ["what is running in dak?", "Two things."]);
  assert.equal(countBobMessages(db, "ilia", "important"), 1, "the urgent message still has its button");
  assert.equal(listBobMessages(db, "ilia", { limit: 2 }).length, 2, "the limit keeps the newest");
  assert.deepEqual(listBobMessages(db, "ilia", { limit: 2 }).map((message) => message.text), ["Prod 5xx at 14%", "Morning report"]);
});

test("a button runs once, only when the message carries it, and returns when the action fails", async () => {
  const { BobActionError, registerBobAction, runBobAction } = await import("../src/control-center/bob-actions.js");
  const { appendBobMessage: append, getBobMessage } = await import("../src/control-center/bob-store.js");
  const db = database();
  const session = { accountId: "ilia" } as never;
  let ran = 0;
  registerBobAction("test.ok", async ({ db: database, session: who, message }) => { ran += 1; return [append(database, (who as { accountId: string }).accountId, { role: "bob", text: `did it for ${message.text}` })]; });
  registerBobAction("test.fail", async () => { throw new Error("nope"); });
  const message = append(db, "ilia", { role: "system", text: "item", importance: "needs-you", actions: [{ id: "test.ok", label: "Do it" }, { id: "test.fail", label: "Fail" }, { id: "test.none", label: "Missing" }] });

  await assert.rejects(runBobAction(db, session, message.id, "not-on-the-message"), (error) => error instanceof BobActionError && error.status === 404);
  await assert.rejects(runBobAction(db, session, message.id, "test.none"), (error) => error instanceof BobActionError && /cannot do that yet/.test(error.message));
  await assert.rejects(runBobAction(db, session, message.id, "test.fail"), /nope/);
  assert.equal(getBobMessage(db, "ilia", message.id)!.actions.length, 3, "the buttons come back after a failure");

  const result = await runBobAction(db, session, message.id, "test.ok");
  assert.equal(result[0].text, "did it for item");
  assert.deepEqual(getBobMessage(db, "ilia", message.id)!.actions, [], "the buttons are gone once one ran");
  assert.equal(getBobMessage(db, "ilia", message.id)!.resolution, "You chose “Do it”.", "the pressed item is cleared, with what was pressed");
  await assert.rejects(runBobAction(db, session, message.id, "test.ok"), (error) => error instanceof BobActionError && error.status === 404);
  assert.equal(ran, 1);
  await assert.rejects(runBobAction(db, { accountId: "other" } as never, message.id, "test.ok"), (error) => error instanceof BobActionError, "another person cannot press it");
});

test("a pressed item is cleared unless its feature put its buttons back; a report keeps its place", async () => {
  const { registerBobAction, runBobAction } = await import("../src/control-center/bob-actions.js");
  const { getBobMessage, setBobActions } = await import("../src/control-center/bob-store.js");
  const db = database();
  const session = { accountId: "ilia" } as never;
  registerBobAction("test.opens", async ({ db: database, message }) => { setBobActions(database, "ilia", message.id, message.actions); });
  registerBobAction("test.quiet", async () => undefined);
  const opens = appendBobMessage(db, "ilia", { role: "system", text: "webhook", importance: "urgent", actions: [{ id: "test.opens", label: "Open" }, { id: "test.quiet", label: "Snooze" }] });
  await runBobAction(db, session, opens.id, "test.opens");
  assert.equal(getBobMessage(db, "ilia", opens.id)!.resolvedAt, null, "a button that only opens something leaves the item waiting");
  assert.equal(getBobMessage(db, "ilia", opens.id)!.actions.length, 2);
  const report = appendBobMessage(db, "ilia", { role: "bob", text: "Morning report", importance: "report", actions: [{ id: "test.quiet", label: "Summary: menu" }] });
  await runBobAction(db, session, report.id, "test.quiet");
  assert.equal(getBobMessage(db, "ilia", report.id)!.resolvedAt, null, "a report stays in the chat");
});

test("a cleared item loses its buttons, says why, leaves the open items and the count, and is listed among the cleared", async () => {
  const { listOpenBobMessages, noteBobRecheck, resolveBobMessage } = await import("../src/control-center/bob-store.js");
  const db = database();
  const ask = appendBobMessage(db, "ilia", { role: "bob", text: "\"Fix the menu\" waits for you.", importance: "needs-you", projectId: "p1", projectName: "Joint Bob", actions: [{ id: "conversation.done", label: "Done" }] });
  appendBobMessage(db, "ilia", { role: "bob", text: "Morning report", importance: "report", actions: [{ id: "report.summary", label: "Summary" }] });
  appendBobMessage(db, "ilia", { role: "bob", text: "Two things." });
  assert.deepEqual(listOpenBobMessages(db, "ilia").map((message) => [message.id, message.originNodeId, message.recheckHash]), [[ask.id, null, null]], "reports and plain answers are not items");
  noteBobRecheck(db, "ilia", ask.id, "hash-1");
  assert.equal(listOpenBobMessages(db, "ilia")[0].recheckHash, "hash-1");
  assert.equal(countBobMessages(db, "ilia", "important"), 1);

  resolveBobMessage(db, "ilia", ask.id, "You looked at it.");
  const cleared = listBobMessages(db, "ilia").find((message) => message.id === ask.id)!;
  assert.deepEqual([cleared.actions, cleared.resolution, Boolean(cleared.resolvedAt)], [[], "You looked at it.", true]);
  assert.deepEqual(listOpenBobMessages(db, "ilia"), []);
  assert.equal(countBobMessages(db, "ilia", "important"), 0, "the badge no longer counts it");
  assert.deepEqual(listBobMessages(db, "ilia", { cleared: true }).map((message) => message.id), [ask.id], "only cleared items in the cleared view");
});

test("a notice whose buttons an older version took away without clearing it is settled; messages that never had buttons stay", async () => {
  const { settleButtonlessItems, setBobActions } = await import("../src/control-center/bob-store.js");
  const db = database();
  const stuck = appendBobMessage(db, "ilia", { role: "bob", text: "\"build search bar\" waits for you.", importance: "needs-you", via: "Review check · Decision model 98%", projectId: "p1", projectName: "DAK", actions: [{ id: "conversation.done", label: "Done" }] });
  setBobActions(db, "ilia", stuck.id, []);
  const waiting = appendBobMessage(db, "ilia", { role: "system", text: "Allow this?", importance: "needs-ok", via: "Guardian · production steps ask you", actions: [{ id: "guardian.allow", label: "Allow once" }] });
  const told = appendBobMessage(db, "ilia", { role: "bob", text: "Told \"build search bar\" to go on.", importance: "done", via: "Review check · you pressed the button" });
  const failed = appendBobMessage(db, "ilia", { role: "bob", text: "The dashboard agent stopped.", importance: "needs-you", via: "Dashboards · agent failed" });
  assert.equal(settleButtonlessItems(db, "ilia", "Settled before."), 1);
  const after = new Map(listBobMessages(db, "ilia").map((message) => [message.id, message.resolution]));
  assert.deepEqual([after.get(stuck.id), after.get(waiting.id), after.get(told.id), after.get(failed.id)], ["Settled before.", null, null, null]);
  assert.equal(settleButtonlessItems(db, "ilia", "Settled before."), 0, "once is enough");
});
