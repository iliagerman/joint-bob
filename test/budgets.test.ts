import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { budgetWindow, evaluateBudgets, firstExceeded, getClusterPolicy, describeBudget, peersMissingPolicy, publishClusterPolicy, receiveClusterPolicy, recordPolicyAck, setLocalLimits, clusterBudgetPolicySchema, EMPTY_POLICY, type BudgetProject, type SpendReader } from "../src/budgets.js";

const CLUSTER = "11111111-1111-4111-8111-111111111111";
const project: BudgetProject = { id: "p1", type: "ws", clusterIds: [CLUSTER] };
const sibling: BudgetProject = { id: "p2", type: "ws", clusterIds: [CLUSTER] };
const elsewhere: BudgetProject = { id: "p3", type: "other", clusterIds: [] };
const now = new Date("2026-10-14T10:30:00.000Z"); // a Wednesday

/** Spend per project id inside the window; the reader ignores the window unless told otherwise. */
const ledger = (spent: Record<string, number>): SpendReader => (subject) => subject.projectIds.reduce((sum, id) => sum + (spent[id] ?? 0), 0);
const policy = (patch: Partial<typeof EMPTY_POLICY> = {}) => clusterBudgetPolicySchema.parse({ ...EMPTY_POLICY, ...patch });
const evaluate = (db: DatabaseSync, spent: Record<string, number>, conversationId = "c1") =>
  evaluateBudgets({ db, project, projects: [project, sibling, elsewhere], conversationId, spend: ledger(spent), now });

test("calendar windows start where the manager's calendar says", () => {
  assert.equal(budgetWindow("hour", now).start.toISOString(), "2026-10-14T10:00:00.000Z");
  assert.equal(budgetWindow("day", now).end!.toISOString(), "2026-10-15T00:00:00.000Z");
  assert.equal(budgetWindow("week", now).start.toISOString(), "2026-10-12T00:00:00.000Z");
  assert.equal(budgetWindow("week", new Date("2026-10-18T23:00:00.000Z")).start.toISOString(), "2026-10-12T00:00:00.000Z");
  assert.equal(budgetWindow("month", now).end!.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(budgetWindow("year", now).start.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(budgetWindow("total", now).end, null);
  // Tel Aviv, UTC+3: 02:00 on the 15th there is still 23:00 on the 14th in UTC, and a new day.
  assert.equal(budgetWindow("day", new Date("2026-10-14T23:00:00.000Z"), 180).start.toISOString(), "2026-10-14T21:00:00.000Z");
  // New York, UTC-4: 02:00 UTC on the 15th is still the 14th there.
  assert.equal(budgetWindow("day", new Date("2026-10-15T02:00:00.000Z"), -240).start.toISOString(), "2026-10-14T04:00:00.000Z");
});

test("a cluster's limit and defaults apply to every project in it, and nothing outside", () => {
  const db = new DatabaseSync(":memory:");
  publishClusterPolicy(db, CLUSTER, "manager", policy({
    limits: [{ period: "month", usd: 100 }],
    defaults: { workspace: [{ period: "day", usd: 30 }], project: [{ period: "day", usd: 20 }], conversation: [{ period: "hour", usd: 5 }] },
  }));
  const statuses = evaluate(db, { p1: 4 });
  assert.deepEqual(statuses.map((status) => `${status.rule.kind}:${status.rule.limit.period}:${status.rule.limit.usd}`).sort(),
    ["cluster:month:100", "conversation:hour:5", "project:day:20", "workspace:day:30"]);
  assert.equal(firstExceeded(statuses), undefined);
  // A project outside every cluster has no rules from one.
  assert.deepEqual(evaluateBudgets({ db, project: elsewhere, projects: [elsewhere], conversationId: "c", spend: ledger({ p3: 999 }), now }), []);
});

test("the cluster total counts what every project in the cluster spent", () => {
  const db = new DatabaseSync(":memory:");
  publishClusterPolicy(db, CLUSTER, "manager", policy({ limits: [{ period: "day", usd: 10 }] }));
  assert.equal(firstExceeded(evaluate(db, { p1: 4, p2: 5 })), undefined);
  const hit = firstExceeded(evaluate(db, { p1: 4, p2: 6, p3: 50 }));
  assert.equal(hit?.rule.kind, "cluster");
  assert.equal(hit?.spentUsd, 10, "a project outside the cluster adds nothing");
  assert.match(describeBudget(hit!, { cluster: () => "Team" }), /daily limit of \$10\.00 for cluster Team is used up/);
});

test("an owner's own limit adds to the cluster's and can only tighten it", () => {
  const db = new DatabaseSync(":memory:");
  publishClusterPolicy(db, CLUSTER, "manager", policy({ defaults: { workspace: [], project: [{ period: "day", usd: 20 }], conversation: [] } }));
  setLocalLimits(db, { kind: "project", subjectId: "p1" }, [{ period: "day", usd: 50 }], 0);
  // The owner asked for $50, but the cluster's $20 still stops the project.
  assert.equal(firstExceeded(evaluate(db, { p1: 25 }))?.rule.source, "cluster");
  setLocalLimits(db, { kind: "project", subjectId: "p1" }, [{ period: "day", usd: 8 }], 0);
  const hit = firstExceeded(evaluate(db, { p1: 9 }));
  assert.equal(hit?.rule.source, "local");
  assert.equal(hit?.rule.limit.usd, 8);
  // Conversation limits are per conversation.
  setLocalLimits(db, { kind: "conversation", subjectId: "c1", projectId: "p1" }, [{ period: "total", usd: 1 }], 0);
  assert.equal(evaluate(db, {}, "c2").some((status) => status.rule.kind === "conversation"), false);
  assert.equal(evaluate(db, {}, "c1").find((status) => status.rule.kind === "conversation")?.resetsAt, null);
});

test("a warning shows before the limit and clears when the window rolls over", () => {
  const db = new DatabaseSync(":memory:");
  setLocalLimits(db, { kind: "project", subjectId: "p1" }, [{ period: "day", usd: 10 }], 0);
  const status = evaluate(db, { p1: 8.5 })[0];
  assert.equal(status.warning, true);
  assert.equal(status.exceeded, false);
  assert.equal(status.resetsAt, "2026-10-15T00:00:00.000Z");
  // The reader gets the window, so tomorrow's spend starts from nothing.
  const windows: Array<[string | undefined, string | undefined]> = [];
  evaluateBudgets({ db, project, projects: [project], conversationId: "c1", spend: (_subject, from, to) => { windows.push([from, to]); return 0; }, now });
  assert.deepEqual(windows, [["2026-10-14T00:00:00.000Z", "2026-10-15T00:00:00.000Z"]]);
});

test("a policy is only replaced by a newer revision", () => {
  const db = new DatabaseSync(":memory:");
  const first = policy({ limits: [{ period: "day", usd: 10 }] });
  assert.equal(receiveClusterPolicy(db, CLUSTER, "manager", 3, first), true);
  assert.equal(receiveClusterPolicy(db, CLUSTER, "manager", 3, policy({ limits: [{ period: "day", usd: 99 }] })), false);
  assert.equal(receiveClusterPolicy(db, CLUSTER, "manager", 2, policy({ limits: [{ period: "day", usd: 99 }] })), false);
  assert.equal(getClusterPolicy(db, CLUSTER)?.policy.limits[0].usd, 10);
  assert.equal(receiveClusterPolicy(db, CLUSTER, "next-manager", 4, policy({ limits: [{ period: "day", usd: 12 }] })), true);
  assert.equal(getClusterPolicy(db, CLUSTER)?.managerNodeId, "next-manager");
  assert.throws(() => receiveClusterPolicy(db, CLUSTER, "manager", 5, { limits: [{ period: "day", usd: -1 }] }));
});

test("members stay pending until they confirm the current revision", () => {
  const db = new DatabaseSync(":memory:");
  publishClusterPolicy(db, CLUSTER, "manager", policy({ limits: [{ period: "day", usd: 10 }] }));
  assert.deepEqual(peersMissingPolicy(db, CLUSTER, ["a", "b"]), ["a", "b"]);
  recordPolicyAck(db, "a", CLUSTER, 1);
  assert.deepEqual(peersMissingPolicy(db, CLUSTER, ["a", "b"]), ["b"]);
  publishClusterPolicy(db, CLUSTER, "manager", policy({ limits: [{ period: "day", usd: 20 }] }));
  assert.deepEqual(peersMissingPolicy(db, CLUSTER, ["a", "b"]), ["a", "b"], "an edit is sent to everyone again");
});

test("limits are validated", () => {
  assert.throws(() => clusterBudgetPolicySchema.parse({ ...EMPTY_POLICY, limits: [{ period: "day", usd: 0 }] }));
  assert.throws(() => clusterBudgetPolicySchema.parse({ ...EMPTY_POLICY, limits: [{ period: "day", usd: 1 }, { period: "day", usd: 2 }] }));
  assert.throws(() => clusterBudgetPolicySchema.parse({ ...EMPTY_POLICY, utcOffsetMinutes: 900 }));
});
