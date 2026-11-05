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
  await assert.rejects(runBobAction(db, session, message.id, "test.ok"), (error) => error instanceof BobActionError && error.status === 404);
  assert.equal(ran, 1);
  await assert.rejects(runBobAction(db, { accountId: "other" } as never, message.id, "test.ok"), (error) => error instanceof BobActionError, "another person cannot press it");
});
