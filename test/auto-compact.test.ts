import assert from "node:assert/strict";
import test from "node:test";
import { armAutoCompactAfterPrompt, autoCompactBetweenTurns } from "../src/server/harness-chat.js";
import type { SharedHarnessSession } from "../src/server/harness-sessions.js";

function sharedSession(percent: number, compact: () => Promise<void>): SharedHarnessSession {
  const session = {
    id: "session",
    status: () => ({ contextUsage: { percent } }),
    isBusy: () => false,
    compact,
  };
  return { session, turnInFlight: 0 } as unknown as SharedHarnessSession;
}

test("auto compact runs once at the configured threshold and rearms after a prompt", async () => {
  let compactions = 0;
  const shared = sharedSession(70, async () => {
    assert.equal(shared.turnInFlight, 1, "compaction is published as in-flight work");
    compactions += 1;
  });

  assert.equal(await autoCompactBetweenTurns(shared, 70), true);
  assert.equal(await autoCompactBetweenTurns(shared, 70), false, "stale usage must not compact in a loop");
  armAutoCompactAfterPrompt(shared.session);
  assert.equal(await autoCompactBetweenTurns(shared, 70), true);
  assert.equal(compactions, 2);
});

test("auto compact stays disabled below threshold, when configured off, and during work", async () => {
  let compactions = 0;
  const shared = sharedSession(69, async () => { compactions += 1; });

  assert.equal(await autoCompactBetweenTurns(shared, 70), false);
  assert.equal(await autoCompactBetweenTurns(shared, null), false);
  shared.turnInFlight = 1;
  assert.equal(await autoCompactBetweenTurns(shared, 1), false);
  shared.turnInFlight = 0;
  shared.session.isBusy = () => true;
  assert.equal(await autoCompactBetweenTurns(shared, 1), false);
  assert.equal(compactions, 0);
});
