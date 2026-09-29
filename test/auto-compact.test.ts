import assert from "node:assert/strict";
import test from "node:test";
import { armAutoCompactAfterPrompt, autoCompactBetweenTurns } from "../src/server/harness-chat.js";
import { COMPACTION_INACTIVITY_TIMEOUT_MS, CONVERSATION_INACTIVITY_TIMEOUT_MS } from "../src/conversation-watchdog.js";
import { harnessSessionKey, harnessSessions, reapInactiveHarnessSessions, type SharedHarnessSession } from "../src/server/harness-sessions.js";

let sessions = 0;

function sharedSession(percent: number, compact: () => Promise<void>, id = `session-${++sessions}`): SharedHarnessSession {
  const session = {
    id,
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

test("a failed auto compact is attempted once per turn, not on every wake-up", async () => {
  let compactions = 0;
  const shared = sharedSession(90, async () => {
    compactions += 1;
    throw new Error("Summarization failed: usage limit reached");
  });

  await assert.rejects(autoCompactBetweenTurns(shared, 70), /usage limit reached/);
  assert.equal(await autoCompactBetweenTurns(shared, 70), false, "a failed compaction must not retry on the next poll");
  assert.equal(shared.turnInFlight, 0, "a failed compaction releases its in-flight slot");
  armAutoCompactAfterPrompt(shared.session);
  await assert.rejects(autoCompactBetweenTurns(shared, 70), /usage limit reached/);
  assert.equal(compactions, 2);
});

test("a reopened session does not retry a compaction its conversation already attempted", async () => {
  let compactions = 0;
  const first = sharedSession(90, async () => { compactions += 1; throw new Error("Compaction cancelled"); }, "reopened");
  await assert.rejects(autoCompactBetweenTurns(first, 70), /cancelled/);

  const reopened = sharedSession(90, async () => { compactions += 1; }, "reopened");
  assert.equal(await autoCompactBetweenTurns(reopened, 70), false, "a fresh session object must not restart the loop");
  armAutoCompactAfterPrompt(reopened.session);
  assert.equal(await autoCompactBetweenTurns(reopened, 70), true);
  assert.equal(compactions, 2);
});

test("the watchdog lets a silent compaction run past the turn timeout and releases one that never settles", async () => {
  const cancelled: string[] = [];
  const shared = sharedSession(90, () => new Promise<void>(() => {}), "silent-compaction");
  Object.assign(shared, { engine: "pi", projectId: "project", conversationId: "silent-compaction", lastActivityAt: 0, clients: new Set() });
  Object.assign(shared.session, { cancel: async () => { cancelled.push(shared.session.id); }, status: () => ({ contextUsage: { percent: 90 } }) });
  harnessSessions.set(harnessSessionKey("project", "pi", shared.session.id), shared);
  try {
    const compaction = autoCompactBetweenTurns(shared, 70);
    const startedAt = shared.lastActivityAt;
    assert.ok(startedAt > 0, "compaction counts as input for the watchdog");

    await reapInactiveHarnessSessions(startedAt + CONVERSATION_INACTIVITY_TIMEOUT_MS + 1);
    assert.deepEqual(cancelled, [], "a compaction is not stopped at the ordinary turn timeout");
    assert.equal(shared.turnInFlight, 1);

    await reapInactiveHarnessSessions(startedAt + COMPACTION_INACTIVITY_TIMEOUT_MS + 1);
    assert.deepEqual(cancelled, ["silent-compaction"]);
    await assert.rejects(compaction, /Compaction stopped after 30 minutes/);
    assert.equal(shared.turnInFlight, 0, "an unresponsive compaction no longer holds the turn slot");
    assert.equal(shared.compaction, undefined);
  } finally {
    harnessSessions.clear();
  }
});
