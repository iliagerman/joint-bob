import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BrowserMonitorActions } from "../src/browser-monitor-actions.js";
import type { BrowserMonitorRuleInput } from "../src/browser-monitor-rules.js";
import type { MonitorInput, MonitorItem } from "../src/browser-monitor-types.js";
import { BrowserMonitorStore } from "../src/browser-monitors.js";

const binding = () => ({ nodeId: randomUUID(), sessionId: randomUUID(), profileId: randomUUID(), pageId: randomUUID(), engine: "pi" as const, conversationId: "conversation" });
const monitorInput = (projectId = "project", targets: string[] = []): MonitorInput => ({ projectId, name: "Inbox", checkerId: "fixture", checkerVersion: 1, origin: "https://example.com", accountId: "account", targetIds: targets, intervalSeconds: 10, binding: binding(), readAcknowledged: true });
const ruleInput = (mode: "approval" | "automatic" = "approval"): BrowserMonitorRuleInput => ({ name: "Reply", priority: 1, targetIds: [], senderIds: [], excludedTargetIds: [], excludedSenderIds: [], textContains: null, caseSensitive: false, aiCondition: null, action: { type: "reply", mode, content: { type: "ai", instructions: "reply", provider: "p", modelId: "m" } }, cooldownSeconds: 60, maxRepliesPerHour: 2 });
const item = (externalId: string, targetId = "chat", senderId = "sender", occurredAt: number | null = 1): MonitorItem => ({ externalId, targetId, targetLabel: targetId, senderId, direction: "incoming", kind: "message.received", text: "same", occurredAt, identity: "stable" });
function fixture(mode: "approval" | "automatic" = "approval", openedDb?: DatabaseSync) {
  const db = openedDb ?? new DatabaseSync(":memory:"); const monitors = new BrowserMonitorStore(db); const owner = randomUUID();
  let monitor = monitors.create(monitorInput(), owner, 0); monitor = monitors.setEnabled(monitor.id, monitor.generation, true, 0);
  let rule = monitors.createRule(monitor.id, ruleInput(mode), 0); rule = monitors.setRuleEnabled(monitor.id, rule.id, rule.version, true, 0);
  let run = monitors.claim(monitor.id, owner, 0)!; monitors.complete(run.id, { accountId: "account", items: [], checkpoint: {}, complete: true, detail: "" }, 1);
  const add = (items: MonitorItem[], now: number) => { monitors.requestCheck(monitor.id, monitor.generation, now); run = monitors.claim(monitor.id, owner, now)!; return monitors.complete(run.id, { accountId: "account", items, checkpoint: {}, complete: true, detail: "" }, now + 1); };
  return { db, monitors, actions: new BrowserMonitorActions(db), monitor, rule, owner, add };
}

type Fixture = ReturnType<typeof fixture>;
type FencedOperation = "claim" | "saveDraft" | "editDraft" | "approve";

function operationStage(x: Fixture, operation: FencedOperation, suffix: string) {
  const [event] = x.add([item(`${operation}-${suffix}`)], 10);
  const queued = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [event.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100);
  if (operation === "claim") {
    return { action: queued, invoke: () => x.actions.claim("project", queued.id, queued.version, 1100) };
  }
  const claimed = x.actions.claim("project", queued.id, queued.version, 1100);
  if (operation === "saveDraft") {
    return { action: claimed, invoke: () => x.actions.saveDraft("project", claimed.id, claimed.claimToken!, { text: "Draft", sourceRevision: "rev", recipients: ["alice"] }, 1200) };
  }
  const drafted = x.actions.saveDraft("project", claimed.id, claimed.claimToken!, { text: "Draft", sourceRevision: "rev", recipients: ["alice"] }, 1200);
  if (operation === "editDraft") {
    return { action: drafted, invoke: () => x.actions.editDraft("project", drafted.id, drafted.version, "Edited", 1300) };
  }
  return { action: drafted, invoke: () => x.actions.approve("project", drafted.id, drafted.version, 1300) };
}

function assertUnchanged(x: Fixture, before: ReturnType<BrowserMonitorActions["getForProject"]>): void {
  assert.deepEqual(x.actions.getForProject("project", before.id), before);
}

test("aggregates participants, preserves ordering, deadlines and assignment uniqueness", () => {
  const x = fixture(); try {
    const [later, earlier] = x.add([item("later", "chat", "alice", 20), item("earlier", "chat", "bob", 10)], 10);
    const first = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [later.id], { quietSeconds: 10, maxWaitSeconds: 30 }, 1000);
    const joined = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [earlier.id], { quietSeconds: 10, maxWaitSeconds: 30 }, 2000);
    assert.equal(joined.id, first.id); assert.deepEqual(joined.eventIds, [earlier.id, later.id]); assert.equal(joined.dueAt, 12000); assert.equal(joined.deadlineAt, 31000);
    assert.equal(x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, joined.eventIds, { quietSeconds: 20, maxWaitSeconds: 40 }, 3000).dueAt, 12000);
    const [other] = x.add([item("other", "other")], 20); assert.notEqual(x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [other.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 4000).id, first.id);
    assert.throws(() => x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [later.id, other.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 4000), /already assigned/);
  } finally { x.actions.close(); }
});

test("continuous arrivals clamp the quiet deadline", () => {
  const x = fixture();
  try {
    const events = x.add(Array.from({ length: 4 }, (_, index) => item(`continuous-${index}`)), 10);
    const enqueueTimes = [1000, 10000, 19000, 28000];
    const actions = events.map((event, index) => x.actions.enqueue(
      "project",
      x.monitor.id,
      x.rule.id,
      x.rule.version,
      [event.id],
      { quietSeconds: 10, maxWaitSeconds: 30 },
      enqueueTimes[index],
    ));
    assert.equal(new Set(actions.map(action => action.id)).size, 1);
    assert.deepEqual(actions.map(action => action.deadlineAt), [31000, 31000, 31000, 31000]);
    assert.equal(actions.at(-1)!.dueAt, 31000);
    assert.deepEqual(new Set(actions.at(-1)!.eventIds), new Set(events.map(event => event.id)));
  } finally {
    x.actions.close();
  }
});

test("enqueue rejects unknown window fields", () => {
  const fixtureData = fixture();
  try {
    const [event] = fixtureData.add([item("one")], 10);
    assert.throws(
      () => fixtureData.actions.enqueue(
        "project",
        fixtureData.monitor.id,
        fixtureData.rule.id,
        fixtureData.rule.version,
        [event.id],
        { quietSeconds: 1, maxWaitSeconds: 2, extra: true } as never,
        100,
      ),
      /unrecognized/i,
    );
  } finally {
    fixtureData.actions.close();
  }
});

test("claim draft approval and edits are version and token fenced", () => {
  const x = fixture("automatic"); try {
    const [event] = x.add([item("one")], 10); const queued = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [event.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100);
    assert.throws(() => x.actions.claim("project", queued.id, queued.version, 1099));
    const claimed = x.actions.claim("project", queued.id, queued.version, 1100); assert.equal(claimed.state, "generating");
    const drafted = x.actions.saveDraft("project", claimed.id, claimed.claimToken!, { text: "Hello", sourceRevision: "rev", recipients: ["alice"] }, 1200);
    assert.equal(drafted.state, "awaiting-approval"); assert.equal(drafted.draftHash, createHash("sha256").update("Hello").digest("hex"));
    const approved = x.actions.approve("project", drafted.id, drafted.version, 1300); assert.equal(approved.state, "approved");
    const edited = x.actions.editDraft("project", approved.id, approved.version, "Changed", 1400); assert.equal(edited.state, "awaiting-approval"); assert.deepEqual(edited.recipients, ["alice"]);
    assert.throws(() => x.actions.approve("project", edited.id, approved.version, 1500), /changed/);
    assert.throws(() => x.actions.saveDraft("project", claimed.id, claimed.claimToken!, { text: "late", sourceRevision: "r", recipients: ["a"] }));
  } finally { x.actions.close(); }
});

test("persisted approval metadata is validated after project scoping", () => {
  const fixtureData = fixture();
  try {
    const [event] = fixtureData.add([item("corrupt")], 10);
    const queued = fixtureData.actions.enqueue("project", fixtureData.monitor.id, fixtureData.rule.id, fixtureData.rule.version, [event.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100);
    const claimed = fixtureData.actions.claim("project", queued.id, queued.version, 1100);
    const drafted = fixtureData.actions.saveDraft("project", claimed.id, claimed.claimToken!, { text: "Hello", sourceRevision: "rev", recipients: ["alice"] }, 1200);
    fixtureData.db.prepare("UPDATE browser_monitor_actions SET draft_hash=? WHERE id=?").run("0".repeat(64), drafted.id);
    assert.throws(() => fixtureData.actions.getForProject("wrong", drafted.id), /not found/);
    assert.throws(() => fixtureData.actions.getForProject("project", drafted.id), /hash does not match/);
    fixtureData.db.prepare("UPDATE browser_monitor_actions SET draft_hash=?, recipients='[]' WHERE id=?").run(createHash("sha256").update("Hello").digest("hex"), drafted.id);
    assert.throws(() => fixtureData.actions.getForProject("project", drafted.id), /incomplete draft metadata/);
  } finally {
    fixtureData.actions.close();
  }
});

test("manual cancellation is exact and suppresses late drafts", () => {
  const x = fixture(); try {
    const events = x.add([item("a", "chat"), item("b", "other")], 10);
    const a = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [events[0].id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100);
    const b = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [events[1].id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100);
    const claimed = x.actions.claim("project", a.id, a.version, 1100);
    assert.equal(x.actions.cancelConversation("project", x.monitor.id, "chat", "Manual response", 1200), 1);
    assert.equal(x.actions.getForProject("project", a.id).state, "cancelled"); assert.equal(x.actions.getForProject("project", b.id).state, "collecting");
    assert.throws(() => x.actions.saveDraft("project", a.id, claimed.claimToken!, { text: "late", sourceRevision: "r", recipients: ["a"] }));
    assert.equal(x.monitors.events(x.monitor.id).filter(event => event.processed).length, 2);
  } finally { x.actions.close(); }
});

for (const operation of ["claim", "saveDraft", "editDraft", "approve"] as const) {
  test(`${operation} rejects paused and changed monitor or rule without mutation`, () => {
    for (const fence of ["monitor paused", "monitor changed", "rule paused", "rule changed"] as const) {
      const x = fixture();
      try {
        const staged = operationStage(x, operation, fence);
        const before = x.actions.getForProject("project", staged.action.id);
        if (fence === "monitor paused") {
          x.monitor = x.monitors.setEnabled(x.monitor.id, x.monitor.generation, false, 2000);
        } else if (fence === "monitor changed") {
          x.monitor = x.monitors.update(x.monitor.id, x.monitor.generation, { name: "Changed" }, 2000);
          x.monitor = x.monitors.setEnabled(x.monitor.id, x.monitor.generation, true, 2001);
        } else if (fence === "rule paused") {
          x.rule = x.monitors.setRuleEnabled(x.monitor.id, x.rule.id, x.rule.version, false, 2000);
        } else {
          x.rule = x.monitors.updateRule(x.monitor.id, x.rule.id, x.rule.version, ruleInput(), 2000);
          x.rule = x.monitors.setRuleEnabled(x.monitor.id, x.rule.id, x.rule.version, true, 2001);
        }
        const expected = fence.endsWith("paused") ? new RegExp(`${fence.split(" ")[0]} is paused`) : new RegExp(fence);
        assert.throws(staged.invoke, expected);
        assertUnchanged(x, before);
      } finally {
        x.actions.close();
      }
    }
  });
}

for (const operation of ["claim", "saveDraft", "editDraft", "approve"] as const) {
  test(`${operation} rejects a newly added ignore rule without mutation`, () => {
    const x = fixture(); try {
      const staged = operationStage(x, operation, "new-ignore"); const before = x.actions.getForProject("project", staged.action.id);
      let ignore = x.monitors.createRule(x.monitor.id, { ...ruleInput(), name: "Ignore", priority: 100, action: { type: "ignore" } }, 2000);
      ignore = x.monitors.setRuleEnabled(x.monitor.id, ignore.id, ignore.version, true, 2001);
      assert.equal(ignore.enabled, true); assert.throws(staged.invoke, /rules changed/); assertUnchanged(x, before);
    } finally { x.actions.close(); }
  });
}

test("a changed rule set starts a new collecting batch", () => {
  const x = fixture(); try {
    const [firstEvent] = x.add([item("revision-first")], 10);
    const first = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [firstEvent.id], { quietSeconds: 10, maxWaitSeconds: 20 }, 100);
    let other = x.monitors.createRule(x.monitor.id, { ...ruleInput(), name: "Other", targetIds: ["elsewhere"] }, 200);
    other = x.monitors.setRuleEnabled(x.monitor.id, other.id, other.version, true, 201);
    const [secondEvent] = x.add([item("revision-second")], 300);
    const second = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [secondEvent.id], { quietSeconds: 10, maxWaitSeconds: 20 }, 400);
    assert.notEqual(second.id, first.id); assert.deepEqual(first.eventIds, [firstEvent.id]); assert.deepEqual(second.eventIds, [secondEvent.id]);
  } finally { x.actions.close(); }
});

test("all action mutations are project scoped and preserve the owning record", () => {
  const operations = ["claim", "saveDraft", "editDraft", "approve"] as const;
  for (const operation of operations) {
    const x = fixture();
    try {
      const staged = operationStage(x, operation, `wrong-project-${operation}`);
      const before = x.actions.getForProject("project", staged.action.id);
      const invoke = operation === "claim"
        ? () => x.actions.claim("wrong", before.id, before.version, 2000)
        : operation === "saveDraft"
          ? () => x.actions.saveDraft("wrong", before.id, before.claimToken!, { text: "No", sourceRevision: "r", recipients: ["a"] }, 2000)
          : operation === "editDraft"
            ? () => x.actions.editDraft("wrong", before.id, before.version, "No", 2000)
            : () => x.actions.approve("wrong", before.id, before.version, 2000);
      assert.throws(invoke, /not found/);
      assertUnchanged(x, before);
    } finally {
      x.actions.close();
    }
  }

  const x = fixture();
  try {
    const staged = operationStage(x, "approve", "reject-cancel");
    const before = x.actions.getForProject("project", staged.action.id);
    assert.throws(() => x.actions.getForProject("wrong", before.id), /not found/);
    assert.throws(() => x.actions.reject("wrong", before.id, before.version, 2000), /not found/);
    assert.throws(() => x.actions.cancelConversation("wrong", x.monitor.id, before.targetId, "No", 2000), /not found/);
    assert.deepEqual(x.actions.list("wrong"), []);
    assertUnchanged(x, before);
  } finally {
    x.actions.close();
  }
});

function legacyActionStages(x: Fixture) {
  const targets = ["collecting", "generating", "awaiting-approval", "approved", "rejected", "cancelled"];
  const events = x.add(targets.map(target => item(`migration-${target}`, target)), 10);
  const queued = Object.fromEntries(events.map(event => [event.targetId, x.actions.enqueue(
    "project", x.monitor.id, x.rule.id, x.rule.version, [event.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100,
  )]));
  const generating = x.actions.claim("project", queued.generating.id, queued.generating.version, 1100);
  const awaitingClaim = x.actions.claim("project", queued["awaiting-approval"].id, queued["awaiting-approval"].version, 1100);
  const awaiting = x.actions.saveDraft("project", awaitingClaim.id, awaitingClaim.claimToken!, { text: "Awaiting", sourceRevision: "rev-await", recipients: ["alice"] }, 1200);
  const approvedClaim = x.actions.claim("project", queued.approved.id, queued.approved.version, 1100);
  const approvedDraft = x.actions.saveDraft("project", approvedClaim.id, approvedClaim.claimToken!, { text: "Approved", sourceRevision: "rev-approved", recipients: ["bob"] }, 1200);
  const approved = x.actions.approve("project", approvedDraft.id, approvedDraft.version, 1300);
  const rejected = x.actions.reject("project", queued.rejected.id, queued.rejected.version, 500);
  assert.equal(x.actions.cancelConversation("project", x.monitor.id, "cancelled", "Already cancelled", 500), 1);
  const cancelled = x.actions.getForProject("project", queued.cancelled.id);
  return [queued.collecting, generating, awaiting, approved, rejected, cancelled];
}

test("legacy action table migration cancels active work once and survives disk reopen", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-actions-migration-"));
  const databasePath = path.join(root, "actions.db");
  let openActions: BrowserMonitorActions | undefined;
  try {
    const x = fixture("approval", new DatabaseSync(databasePath));
    openActions = x.actions;
    const before = legacyActionStages(x);
    const approved = before[3];
    const beforeEvents = x.monitors.events(x.monitor.id);
    const beforeMembers = x.db.prepare("SELECT event_id,action_id,ordinal FROM browser_monitor_action_events ORDER BY event_id").all();

    x.db.exec("ALTER TABLE browser_monitor_actions DROP COLUMN rules_revision");
    const migratedActions = new BrowserMonitorActions(x.db);
    openActions = migratedActions;
    const migrated = before.map(action => migratedActions.getForProject("project", action.id));
    const zeros = "0".repeat(64);
    const detail = "Rule authorization requires renewal after upgrade";
    for (let index = 0; index < 4; index += 1) {
      assert.deepEqual(migrated[index], { ...before[index], state: "cancelled", version: before[index].version + 1, claimToken: null, detail, rulesRevision: zeros });
    }
    for (let index = 4; index < 6; index += 1) {
      assert.deepEqual(migrated[index], { ...before[index], rulesRevision: zeros });
    }
    assert.throws(() => migratedActions.approve("project", approved.id, migrated[3].version, 1400), /state does not allow/);
    assert.deepEqual(x.monitors.events(x.monitor.id), beforeEvents);
    assert.deepEqual(x.db.prepare("SELECT event_id,action_id,ordinal FROM browser_monitor_action_events ORDER BY event_id").all(), beforeMembers);
    assert.equal(new Set(migrated.flatMap(action => action.eventIds)).size, 6);

    migratedActions.close();
    openActions = undefined;
    const reopened = new BrowserMonitorActions(new DatabaseSync(databasePath));
    openActions = reopened;
    assert.deepEqual(migrated.map(action => reopened.getForProject("project", action.id)), migrated);
  } finally {
    openActions?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("actions and approval metadata survive closing and reopening SQLite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-actions-persist-"));
  const databasePath = path.join(root, "actions.db");
  let first: Fixture | undefined;
  let reopened: BrowserMonitorActions | undefined;
  try {
    first = fixture("approval", new DatabaseSync(databasePath));
    const [event] = first.add([item("persistent")], 10);
    const queued = first.actions.enqueue("project", first.monitor.id, first.rule.id, first.rule.version, [event.id], { quietSeconds: 2, maxWaitSeconds: 9 }, 100);
    const claimed = first.actions.claim("project", queued.id, queued.version, 2100);
    const drafted = first.actions.saveDraft("project", claimed.id, claimed.claimToken!, { text: "Durable draft", sourceRevision: "revision-7", recipients: ["alice", "bob"] }, 2200);
    first.actions.close();
    first = undefined;

    reopened = new BrowserMonitorActions(new DatabaseSync(databasePath));
    const persisted = reopened.getForProject("project", drafted.id);
    assert.deepEqual(persisted.eventIds, [event.id]);
    assert.equal(persisted.deadlineAt, queued.deadlineAt);
    assert.equal(persisted.dueAt, queued.dueAt);
    assert.equal(persisted.draft, "Durable draft");
    assert.equal(persisted.draftHash, createHash("sha256").update("Durable draft").digest("hex"));
    assert.equal(persisted.sourceRevision, "revision-7");
    assert.deepEqual(persisted.recipients, ["alice", "bob"]);
  } finally {
    if (first) first.actions.close();
    if (reopened) reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("competing stale SQLite connections produce one claim and retain one membership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-actions-contention-"));
  const databasePath = path.join(root, "actions.db");
  const seed = fixture("approval", new DatabaseSync(databasePath));
  let first: BrowserMonitorActions | undefined;
  let second: BrowserMonitorActions | undefined;
  try {
    const [event] = seed.add([item("contended")], 10);
    const queued = seed.actions.enqueue("project", seed.monitor.id, seed.rule.id, seed.rule.version, [event.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100);
    seed.actions.close();
    first = new BrowserMonitorActions(new DatabaseSync(databasePath));
    second = new BrowserMonitorActions(new DatabaseSync(databasePath));
    const firstSnapshot = first.getForProject("project", queued.id);
    const secondSnapshot = second.getForProject("project", queued.id);
    const claimed = first.claim("project", firstSnapshot.id, firstSnapshot.version, 1100);
    assert.throws(() => second!.claim("project", secondSnapshot.id, secondSnapshot.version, 1100), /changed/);
    const final = second.getForProject("project", queued.id);
    assert.equal(final.claimToken, claimed.claimToken);
    assert.equal(final.attempts, 1);
    assert.deepEqual(final.eventIds, [event.id]);
  } finally {
    first?.close();
    second?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch capacity, time boundaries, review stickiness and rule separation are enforced", () => {
  const x = fixture();
  try {
    const hundred = x.add(Array.from({ length: 100 }, (_, index) => item(`member-${index}`)), 10);
    const full = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, hundred.map(event => event.id), { quietSeconds: 10, maxWaitSeconds: 20 }, 1000);
    const [overflow] = x.add([item("member-100")], 20);
    assert.notEqual(x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [overflow.id], { quietSeconds: 10, maxWaitSeconds: 20 }, 2000).id, full.id);

    const [early, exactDue, exactDeadline] = x.add([item("early", "quiet"), item("due", "quiet"), item("deadline", "quiet")], 30);
    const quiet = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [early.id], { quietSeconds: 10, maxWaitSeconds: 15 }, 1000);
    const dueBoundary = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [exactDue.id], { quietSeconds: 10, maxWaitSeconds: 15 }, quiet.dueAt);
    assert.notEqual(dueBoundary.id, quiet.id);
    const deadlineBoundary = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [exactDeadline.id], { quietSeconds: 10, maxWaitSeconds: 15 }, quiet.deadlineAt);
    assert.notEqual(deadlineBoundary.id, quiet.id);

    const [base, review] = x.add([item("base", "review"), item("review", "review", "sender", null)], 40);
    x.db.prepare("UPDATE browser_monitor_events SET review_required=0 WHERE id=?").run(base.id);
    const normal = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [base.id], { quietSeconds: 10, maxWaitSeconds: 20 }, 1000);
    assert.equal(normal.reviewRequired, false);
    assert.equal(x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [review.id], { quietSeconds: 10, maxWaitSeconds: 20 }, 2000).reviewRequired, true);
    const [fresh] = x.add([item("fresh", "review")], 41);
    x.db.prepare("UPDATE browser_monitor_events SET review_required=0 WHERE id=?").run(fresh.id);
    const sticky = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [fresh.id], { quietSeconds: 10, maxWaitSeconds: 20 }, 3000);
    assert.equal(sticky.reviewRequired, true);
    assert.deepEqual(new Set(sticky.eventIds), new Set([base.id, review.id, fresh.id]));

    let secondRule = x.monitors.createRule(x.monitor.id, { ...ruleInput(), name: "Second", priority: 2 }, 0);
    secondRule = x.monitors.setRuleEnabled(x.monitor.id, secondRule.id, secondRule.version, true, 0);
    const [separate] = x.add([item("second-rule", "rules")], 50);
    const firstRuleAction = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [separate.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100);
    assert.equal(firstRuleAction.ruleId, x.rule.id);
    const [secondEvent] = x.add([item("second-rule-2", "rules")], 60);
    assert.notEqual(x.actions.enqueue("project", x.monitor.id, secondRule.id, secondRule.version, [secondEvent.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100).id, firstRuleAction.id);
  } finally {
    x.actions.close();
  }
});

test("reply assignment rejects invalid events and invalid sets without consuming valid events", () => {
  const x = fixture();
  try {
    const invalidItems = [
      { ...item("outgoing"), direction: "outgoing" as const },
      { ...item("edited"), kind: "message.edited" as const },
      { ...item("page"), kind: "page.changed" as const },
    ];
    x.add(invalidItems, 10);
    const invalid = x.monitors.events(x.monitor.id).filter(event => ["outgoing", "edited", "page"].includes(event.externalId));
    assert.equal(invalid.length, 3);
    for (const event of invalid) assert.throws(() => x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [event.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100), /cannot form|not eligible|already assigned/);

    const restrictedInput = { ...ruleInput(), senderIds: ["allowed"], excludedTargetIds: ["excluded"], excludedSenderIds: ["blocked"] };
    x.rule = x.monitors.updateRule(x.monitor.id, x.rule.id, x.rule.version, restrictedInput, 20);
    x.rule = x.monitors.setRuleEnabled(x.monitor.id, x.rule.id, x.rule.version, true, 21);
    const excluded = x.add([item("wrong-sender", "chat", "wrong"), item("blocked", "chat", "blocked"), item("excluded", "excluded", "allowed")], 30);
    for (const event of excluded) assert.throws(() => x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [event.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100), /not eligible/);

    const [valid] = x.add([item("valid", "chat", "allowed")], 40);
    const other = fixture("approval", x.db);
    const [otherEvent] = other.add([item("other-monitor", "chat", "allowed")], 41);
    assert.throws(
      () => x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [valid.id, otherEvent.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100),
      /event not found/,
    );
    assert.equal(x.monitors.pendingEvents(x.monitor.id).some(event => event.id === valid.id), true);
    assert.equal(other.monitors.pendingEvents(other.monitor.id).some(event => event.id === otherEvent.id), true);
    const missing = randomUUID();
    assert.throws(() => x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, Array(101).fill(valid.id), { quietSeconds: 1, maxWaitSeconds: 2 }, 100));
    assert.throws(() => x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [valid.id, valid.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100), /unique/);
    assert.throws(() => x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [valid.id, missing], { quietSeconds: 1, maxWaitSeconds: 2 }, 100), /not found/);
    assert.equal(x.monitors.pendingEvents(x.monitor.id).some(event => event.id === valid.id), true);
  } finally {
    x.actions.close();
  }
});

test("recovery is owner scoped, state selective, membership safe and retry bounded", () => {
  const x = fixture();
  try {
    const targets = ["before", "overdue", "generating", "approval", "approved", "rejected", "cancelled"];
    const events = x.add(targets.map(target => item(`recover-${target}`, target)), 10);
    const queued = Object.fromEntries(events.map(event => [event.targetId, x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [event.id], { quietSeconds: event.targetId === "before" ? 10 : 1, maxWaitSeconds: 20 }, 100)]));
    const generating = x.actions.claim("project", queued.generating.id, queued.generating.version, 1100);
    const approvalClaim = x.actions.claim("project", queued.approval.id, queued.approval.version, 1100);
    const awaiting = x.actions.saveDraft("project", approvalClaim.id, approvalClaim.claimToken!, { text: "Await", sourceRevision: "r", recipients: ["a"] }, 1200);
    const approvedClaim = x.actions.claim("project", queued.approved.id, queued.approved.version, 1100);
    const approvedDraft = x.actions.saveDraft("project", approvedClaim.id, approvedClaim.claimToken!, { text: "Approved", sourceRevision: "r", recipients: ["a"] }, 1200);
    const approved = x.actions.approve("project", approvedDraft.id, approvedDraft.version, 1300);
    const rejected = x.actions.reject("project", queued.rejected.id, queued.rejected.version, 500);
    x.actions.cancelConversation("project", x.monitor.id, "cancelled", "Cancelled", 500);
    const cancelled = x.actions.getForProject("project", queued.cancelled.id);

    const secondOwner = randomUUID();
    let otherMonitor = x.monitors.create(monitorInput(), secondOwner, 0);
    otherMonitor = x.monitors.setEnabled(otherMonitor.id, otherMonitor.generation, true, 0);
    let otherRule = x.monitors.createRule(otherMonitor.id, ruleInput(), 0);
    otherRule = x.monitors.setRuleEnabled(otherMonitor.id, otherRule.id, otherRule.version, true, 0);
    let otherRun = x.monitors.claim(otherMonitor.id, secondOwner, 0)!;
    x.monitors.complete(otherRun.id, { accountId: "account", items: [], checkpoint: {}, complete: true, detail: "" }, 1);
    x.monitors.requestCheck(otherMonitor.id, otherMonitor.generation, 10);
    otherRun = x.monitors.claim(otherMonitor.id, secondOwner, 10)!;
    const [otherEvent] = x.monitors.complete(otherRun.id, { accountId: "account", items: [item("other-owner", "other-owner")], checkpoint: {}, complete: true, detail: "" }, 11);
    const otherAction = x.actions.enqueue("project", otherMonitor.id, otherRule.id, otherRule.version, [otherEvent.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100);
    const otherBefore = x.actions.getForProject("project", otherAction.id);

    const beforeSnapshots = [queued.before, awaiting, rejected, cancelled];
    assert.equal(x.actions.recover(x.owner, 2000), 3);
    for (const snapshot of beforeSnapshots) assert.deepEqual(x.actions.getForProject("project", snapshot.id), snapshot);
    const recoveredGenerating = x.actions.getForProject("project", generating.id);
    assert.equal(recoveredGenerating.state, "collecting");
    assert.equal(recoveredGenerating.claimToken, null);
    assert.equal(recoveredGenerating.attempts, 1);
    assert.deepEqual(recoveredGenerating.eventIds, generating.eventIds);
    assert.equal(x.actions.getForProject("project", queued.overdue.id).reviewRequired, true);
    const recoveredApproved = x.actions.getForProject("project", approved.id);
    assert.equal(recoveredApproved.state, "awaiting-approval");
    assert.equal(recoveredApproved.reviewRequired, true);
    assert.deepEqual(recoveredApproved.eventIds, approved.eventIds);
    assert.throws(() => x.actions.saveDraft("project", generating.id, generating.claimToken!, { text: "Stale", sourceRevision: "r", recipients: ["a"] }, 2100), /stale/);
    assert.throws(() => x.actions.approve("project", approved.id, approved.version, 2100), /changed/);
    assert.deepEqual(x.actions.getForProject("project", otherAction.id), otherBefore);

    let retry = x.actions.claim("project", recoveredGenerating.id, recoveredGenerating.version, 2000);
    x.actions.recover(x.owner, 2100);
    retry = x.actions.claim("project", retry.id, retry.version + 1, 2100);
    x.actions.recover(x.owner, 2200);
    const afterThirdRecovery = x.actions.getForProject("project", retry.id);
    assert.equal(afterThirdRecovery.attempts, 3);
    assert.throws(() => x.actions.claim("project", retry.id, afterThirdRecovery.version, 2200), /retry budget exhausted/);
    assert.equal(x.actions.getForProject("project", retry.id).attempts, 3);
    assert.deepEqual(x.actions.getForProject("project", retry.id).eventIds, generating.eventIds);
    assert.equal(x.monitors.events(x.monitor.id).filter(event => event.processed).length, targets.length);
  } finally {
    x.actions.close();
  }
});

test("keyset pagination returns same-time actions exactly once and monitor deletion cascades", () => {
  const x = fixture();
  try {
    const events = x.add(Array.from({ length: 6 }, (_, index) => item(`page-${index}`, `target-${index}`)), 10);
    for (const event of events) x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, [event.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100);
    const expected = x.actions.list("project").map(action => action.id);
    const paged: string[] = [];
    let page = x.actions.list("project", 2);
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      paged.push(...page.map(action => action.id));
      if (page.length === 0) break;
      const last = page.at(-1)!;
      page = x.actions.list("project", 2, { createdAt: last.createdAt, id: last.id });
    }
    assert.deepEqual(page, []);
    assert.deepEqual(paged, expected);
    assert.equal(new Set(paged).size, expected.length);

    const other = fixture("approval", x.db);
    const [otherEvent] = other.add([item("cascade-other", "cascade-other")], 20);
    const otherAction = other.actions.enqueue("project", other.monitor.id, other.rule.id, other.rule.version, [otherEvent.id], { quietSeconds: 1, maxWaitSeconds: 2 }, 100);
    x.monitor = x.monitors.setEnabled(x.monitor.id, x.monitor.generation, false, 200);
    x.monitors.delete(x.monitor.id, x.monitor.generation);
    assert.deepEqual(x.actions.list("project").map(action => action.id), [otherAction.id]);
    const members = x.db.prepare("SELECT event_id,action_id FROM browser_monitor_action_events ORDER BY event_id").all() as unknown as { event_id: string; action_id: string }[];
    assert.deepEqual(members.map(member => ({ ...member })), [{ event_id: otherEvent.id, action_id: otherAction.id }]);
    assert.equal(x.actions.getForProject("project", otherAction.id).id, otherAction.id);
  } finally {
    x.actions.close();
  }
});

test("transaction rollback, project scoping, bounded keyset list and recovery", () => {
  const x = fixture(); try {
    const events = x.add([item("a"), item("b")], 10);
    x.db.exec("CREATE TRIGGER fail_membership BEFORE INSERT ON browser_monitor_action_events WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT, 'membership failed'); END");
    assert.throws(() => x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, events.map(e => e.id), { quietSeconds: 1, maxWaitSeconds: 2 }, 100), /membership failed/);
    assert.equal(x.monitors.pendingEvents(x.monitor.id).length, 2); assert.equal(x.actions.list("project").length, 0); x.db.exec("DROP TRIGGER fail_membership");
    const queued = x.actions.enqueue("project", x.monitor.id, x.rule.id, x.rule.version, events.map(event => event.id), { quietSeconds: 1, maxWaitSeconds: 2 }, 100);
    assert.throws(() => x.actions.getForProject("wrong", queued.id), /not found/); assert.deepEqual(x.actions.list("wrong"), []); assert.throws(() => x.actions.list("project", 201));
    const generating = x.actions.claim("project", queued.id, queued.version, 1100); assert.equal(x.actions.recover(x.owner, 1200), 1);
    const recovered = x.actions.getForProject("project", generating.id); assert.equal(recovered.state, "collecting"); assert.equal(recovered.reviewRequired, true); assert.equal(recovered.attempts, 1);
  } finally { x.actions.close(); }
});
