import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { automationTagAssignmentSchema, ensureAutomationTagSchema, retireAutomationTag, saveAutomationTag, snapshotAutomationTags, validateAutomationTagAssignments } from "../src/automation-tags.js";

test("tag assignments normalize and deduplicate manual tags without adding catalog entries", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureAutomationTagSchema(db);
    const assignments = automationTagAssignmentSchema.parse({ managedTagIds: [], manualTags: ["  Nightly ", "nightly", "Ops"] });
    assert.deepEqual(assignments, { managedTagIds: [], manualTags: ["Nightly", "Ops"] });
    assert.equal((db.prepare("SELECT count(*) AS n FROM automation_tags").get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test("managed tag names are unique after normalization and retired tags cannot be snapshotted", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureAutomationTagSchema(db);
    const tag = saveAutomationTag(db, { workspaceId: "workspace", name: " Nightly  job " });
    assert.throws(() => saveAutomationTag(db, { workspaceId: "workspace", name: "nightly job" }), /already exists/);
    retireAutomationTag(db, "workspace", tag.id);
    assert.throws(() => validateAutomationTagAssignments(db, "workspace", { managedTagIds: [tag.id], manualTags: [] }), /unavailable/);
    assert.deepEqual(snapshotAutomationTags(db, "workspace", { managedTagIds: [tag.id], manualTags: [] }), []);
  } finally { db.close(); }
});

test("execution snapshots preserve display names after managed tag is renamed or retired", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureAutomationTagSchema(db);
    const tag = saveAutomationTag(db, { workspaceId: "workspace", name: "Nightly" });
    const assignment = automationTagAssignmentSchema.parse({ managedTagIds: [tag.id], manualTags: ["Urgent"] });
    const snapshot = snapshotAutomationTags(db, "workspace", assignment);
    db.prepare("UPDATE automation_tags SET name='Overnight', normalized_name='overnight' WHERE id=?").run(tag.id);
    assert.deepEqual(snapshot, [
      { key: "nightly", name: "Nightly", managedTagId: tag.id },
      { key: "urgent", name: "Urgent", managedTagId: null },
    ]);
  } finally { db.close(); }
});

test("tag assignments enforce count and length limits", async () => {
  const { automationTagAssignmentSchema } = await import("../src/automation-tags.js");
  assert.equal(automationTagAssignmentSchema.safeParse({ managedTagIds: [], manualTags: ["x".repeat(81)] }).success, false);
  assert.equal(automationTagAssignmentSchema.safeParse({ managedTagIds: Array.from({ length: 21 }, (_, i) => String(i)), manualTags: [] }).success, false);
});
