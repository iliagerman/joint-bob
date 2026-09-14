import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { cronInputSchema } from "../src/cron.js";

const validInput = (engine: string) => ({
  projectId: "project", name: "Daily check", prompt: "Check status", ownerNodeId: randomUUID(),
  engine, sessionId: null, enabled: true,
  schedule: { frequency: "daily" as const, hour: 9, minute: 30, weekday: 1, timezone: "America/New_York" },
});

test("cron accepts every registered executable harness", () => {
  for (const engine of ["pi", "claude", "kiro"]) assert.equal(cronInputSchema.parse(validInput(engine)).engine, engine);
});

test("cron rejects unknown and unregistered harnesses", () => {
  for (const engine of ["future", "codex"]) assert.throws(() => cronInputSchema.parse(validInput(engine)), /Harness/);
});

test("cron validates schedule timezones", () => {
  assert.equal(cronInputSchema.parse(validInput("kiro")).schedule.timezone, "America/New_York");
  assert.throws(() => cronInputSchema.parse({ ...validInput("kiro"), schedule: { ...validInput("kiro").schedule, timezone: "Mars/Olympus" } }), /Unknown timezone/);
});
