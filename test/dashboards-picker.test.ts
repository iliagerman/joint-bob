import assert from "node:assert/strict";
import test from "node:test";
import { pickerEntries } from "../public/app/dashboard-picker.js";

const own = { id: "a", title: "Mine", origin: "own", saved: true, active: true };
const received = { id: "b", title: "Bugs", origin: "received", saved: true, active: false };
const draft = { id: "c", title: "", origin: "own", saved: false, active: false };

test("the picker reaches every dashboard: received ones and unsaved drafts too", () => {
  assert.deepEqual(pickerEntries([own], "a"), [], "a single dashboard on show needs no picker");
  assert.deepEqual(pickerEntries([received], null).map((entry) => [entry.id, entry.label]), [["b", "Bugs · shared with you"]], "a lone received dashboard is reachable from the empty state");
  assert.deepEqual(pickerEntries([own, received, draft], "a").map((entry) => [entry.id, entry.label]), [
    ["a", "Mine · in use"], ["b", "Bugs · shared with you"], ["c", "New dashboard · draft"],
  ]);
});
