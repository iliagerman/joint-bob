import assert from "node:assert/strict";
import test from "node:test";
import { latestActiveGroups, parseActivityLabel, parseChatRows, redactSensitive } from "../.agents/skills/whatsapp/scripts/whatsapp-lib.mjs";

const today = new Date("2026-09-12T12:00:00Z");

test("WhatsApp skill parses normal and community group rows", () => {
  assert.deepEqual(parseChatRows([
    "3 unread messages\nNeighborhood\n14:27\n~Sam\n:\u00a0\nhello\n3",
    "AI Community\nThursday\n12 unread messages\nAI Jobs\n12\n~Lee\n:\u00a0\nrole",
  ]), [
    { name: "Neighborhood", activity: "14:27" },
    { name: "AI Jobs", activity: "Thursday" },
  ]);
});

test("WhatsApp skill resolves relative activity labels", () => {
  assert.equal(parseActivityLabel("14:27", today).toISOString().slice(0, 10), "2026-09-12");
  assert.equal(parseActivityLabel("Yesterday", today).toISOString().slice(0, 10), "2026-09-11");
  assert.equal(parseActivityLabel("Thursday", today).toISOString().slice(0, 10), "2026-09-10");
  assert.equal(parseActivityLabel("8/14/2026", today).toISOString().slice(0, 10), "2026-08-14");
});

test("WhatsApp skill redacts credentials before message output", () => {
  assert.equal(redactSensitive("Password: hunter2\nOTP = 123456\nordinary update"), "Password: [REDACTED]\nOTP = [REDACTED]\nordinary update");
});

test("WhatsApp skill keeps latest duplicate and filters by age", () => {
  assert.deepEqual(latestActiveGroups([
    { name: "Neighborhood", activity: "6/25/2026" },
    { name: "Neighborhood", activity: "14:27" },
    { name: "Old group", activity: "8/12/2026" },
    { name: "Recent group", activity: "8/14/2026" },
  ], 30, today), [
    { name: "Neighborhood", activity: "14:27", date: "2026-09-12" },
    { name: "Recent group", activity: "8/14/2026", date: "2026-08-14" },
  ]);
});
