import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/**
 * Spend budgets. A cluster's manager sets a cluster-wide limit and per-item defaults for
 * workspaces, projects and conversations; an item's owner may add tighter limits of their own.
 * A turn may start only when every applicable budget still has room, so the cluster's limit
 * always wins. Spend is the ledger's API-equivalent price, not an invoice.
 */
export const BUDGET_PERIODS = ["hour", "day", "week", "month", "year", "total"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];
export type BudgetKind = "cluster" | "workspace" | "project" | "conversation";
export const WARN_RATIO = 0.8;

export const budgetLimitSchema = z.object({ period: z.enum(BUDGET_PERIODS), usd: z.number().finite().positive().max(10_000_000) }).strict();
export type BudgetLimit = z.infer<typeof budgetLimitSchema>;
const limitList = z.array(budgetLimitSchema).max(BUDGET_PERIODS.length)
  .refine((limits) => new Set(limits.map((limit) => limit.period)).size === limits.length, "One limit per period");
export const clusterBudgetPolicySchema = z.object({
  limits: limitList,
  defaults: z.object({ workspace: limitList, project: limitList, conversation: limitList }).strict(),
  /** Minutes east of UTC; fixes where calendar periods begin so every node resets together. */
  utcOffsetMinutes: z.number().int().min(-840).max(840),
}).strict();
export type ClusterBudgetPolicy = z.infer<typeof clusterBudgetPolicySchema>;
export const EMPTY_POLICY: ClusterBudgetPolicy = { limits: [], defaults: { workspace: [], project: [], conversation: [] }, utcOffsetMinutes: 0 };

export class BudgetError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
/** Thrown at turn start; the message is shown to the person and recorded on scheduled runs. */
export class BudgetExceededError extends Error {
  constructor(message: string, readonly status: BudgetStatus) { super(message); }
}

export function ensureBudgetSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS budget_limits(kind TEXT NOT NULL,project_id TEXT NOT NULL DEFAULT '',subject_id TEXT NOT NULL,period TEXT NOT NULL,usd REAL NOT NULL,utc_offset INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,PRIMARY KEY(kind,project_id,subject_id,period));
CREATE TABLE IF NOT EXISTS budget_policies(cluster_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,manager_node_id TEXT NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS budget_policy_acks(peer_id TEXT NOT NULL,cluster_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(peer_id,cluster_id));`);
}

/* ---------- calendar windows ---------- */

/** The window `now` falls in, in the offset's calendar: `[start, end)`; a total never resets. */
export function budgetWindow(period: BudgetPeriod, now: Date, offsetMinutes = 0): { start: Date; end: Date | null } {
  if (period === "total") return { start: new Date(0), end: null };
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  const y = shifted.getUTCFullYear(), m = shifted.getUTCMonth(), d = shifted.getUTCDate(), h = shifted.getUTCHours();
  let start: number, end: number;
  if (period === "hour") { start = Date.UTC(y, m, d, h); end = Date.UTC(y, m, d, h + 1); }
  else if (period === "day") { start = Date.UTC(y, m, d); end = Date.UTC(y, m, d + 1); }
  else if (period === "week") { const back = (shifted.getUTCDay() + 6) % 7; start = Date.UTC(y, m, d - back); end = Date.UTC(y, m, d - back + 7); }
  else if (period === "month") { start = Date.UTC(y, m, 1); end = Date.UTC(y, m + 1, 1); }
  else { start = Date.UTC(y, 0, 1); end = Date.UTC(y + 1, 0, 1); }
  const unshift = offsetMinutes * 60_000;
  return { start: new Date(start - unshift), end: new Date(end - unshift) };
}

/* ---------- storage ---------- */

export interface LocalLimitSubject { kind: Exclude<BudgetKind, "cluster">; subjectId: string; projectId?: string }
const projectKey = (subject: LocalLimitSubject) => subject.kind === "conversation" ? subject.projectId ?? "" : "";

export function listLocalLimits(db: DatabaseSync, subject: LocalLimitSubject): BudgetLimit[] {
  ensureBudgetSchema(db);
  const rows = db.prepare("SELECT period,usd FROM budget_limits WHERE kind=? AND project_id=? AND subject_id=?").all(subject.kind, projectKey(subject), subject.subjectId) as unknown as BudgetLimit[];
  return BUDGET_PERIODS.flatMap((period) => rows.filter((row) => row.period === period).map((row) => ({ period, usd: row.usd })));
}

function localOffset(db: DatabaseSync, subject: LocalLimitSubject): number {
  const row = db.prepare("SELECT utc_offset FROM budget_limits WHERE kind=? AND project_id=? AND subject_id=? LIMIT 1").get(subject.kind, projectKey(subject), subject.subjectId) as { utc_offset: number } | undefined;
  return row?.utc_offset ?? 0;
}

/** Replaces the item's own limits. An empty list removes them. */
export function setLocalLimits(db: DatabaseSync, subject: LocalLimitSubject, limits: BudgetLimit[], utcOffsetMinutes: number, now = new Date().toISOString()): void {
  ensureBudgetSchema(db);
  const parsed = limitList.parse(limits);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM budget_limits WHERE kind=? AND project_id=? AND subject_id=?").run(subject.kind, projectKey(subject), subject.subjectId);
    const insert = db.prepare("INSERT INTO budget_limits(kind,project_id,subject_id,period,usd,utc_offset,updated_at) VALUES(?,?,?,?,?,?,?)");
    for (const limit of parsed) insert.run(subject.kind, projectKey(subject), subject.subjectId, limit.period, limit.usd, utcOffsetMinutes, now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export interface StoredPolicy { clusterId: string; revision: number; managerNodeId: string; policy: ClusterBudgetPolicy; updatedAt: string }

export function getClusterPolicy(db: DatabaseSync, clusterId: string): StoredPolicy | undefined {
  ensureBudgetSchema(db);
  const row = db.prepare("SELECT cluster_id,revision,manager_node_id,payload,updated_at FROM budget_policies WHERE cluster_id=?").get(clusterId) as { cluster_id: string; revision: number; manager_node_id: string; payload: string; updated_at: string } | undefined;
  return row && { clusterId: row.cluster_id, revision: row.revision, managerNodeId: row.manager_node_id, policy: clusterBudgetPolicySchema.parse(JSON.parse(row.payload)), updatedAt: row.updated_at };
}

/** The manager's own edit: always the next revision, whatever it replaced. */
export function publishClusterPolicy(db: DatabaseSync, clusterId: string, managerNodeId: string, policy: ClusterBudgetPolicy, now = new Date().toISOString()): StoredPolicy {
  ensureBudgetSchema(db);
  const parsed = clusterBudgetPolicySchema.parse(policy);
  const revision = (getClusterPolicy(db, clusterId)?.revision ?? 0) + 1;
  db.prepare(`INSERT INTO budget_policies(cluster_id,revision,manager_node_id,payload,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(cluster_id) DO UPDATE SET revision=excluded.revision,manager_node_id=excluded.manager_node_id,payload=excluded.payload,updated_at=excluded.updated_at`)
    .run(clusterId, revision, managerNodeId, JSON.stringify(parsed), now);
  db.prepare("DELETE FROM budget_policy_acks WHERE cluster_id=?").run(clusterId);
  return getClusterPolicy(db, clusterId)!;
}

/**
 * A policy received from `sender`, who the caller has already checked is the cluster's current
 * manager. Older revisions never replace newer ones; an equal revision is a no-op.
 */
export function receiveClusterPolicy(db: DatabaseSync, clusterId: string, sender: string, revision: number, policy: unknown, now = new Date().toISOString()): boolean {
  ensureBudgetSchema(db);
  const parsed = clusterBudgetPolicySchema.parse(policy);
  const current = getClusterPolicy(db, clusterId);
  if (current && current.revision >= revision) return false;
  db.prepare(`INSERT INTO budget_policies(cluster_id,revision,manager_node_id,payload,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(cluster_id) DO UPDATE SET revision=excluded.revision,manager_node_id=excluded.manager_node_id,payload=excluded.payload,updated_at=excluded.updated_at`)
    .run(clusterId, revision, sender, JSON.stringify(parsed), now);
  return true;
}

export function forgetClusterPolicy(db: DatabaseSync, clusterId: string): void {
  ensureBudgetSchema(db);
  db.prepare("DELETE FROM budget_policies WHERE cluster_id=?").run(clusterId);
  db.prepare("DELETE FROM budget_policy_acks WHERE cluster_id=?").run(clusterId);
}

export function recordPolicyAck(db: DatabaseSync, peerId: string, clusterId: string, revision: number): void {
  ensureBudgetSchema(db);
  db.prepare("INSERT INTO budget_policy_acks(peer_id,cluster_id,revision) VALUES(?,?,?) ON CONFLICT(peer_id,cluster_id) DO UPDATE SET revision=excluded.revision").run(peerId, clusterId, revision);
}

/** Members that have not confirmed the policy's current revision. */
export function peersMissingPolicy(db: DatabaseSync, clusterId: string, peers: string[]): string[] {
  ensureBudgetSchema(db);
  const stored = getClusterPolicy(db, clusterId);
  if (!stored) return [];
  return peers.filter((peer) => {
    const ack = db.prepare("SELECT revision FROM budget_policy_acks WHERE peer_id=? AND cluster_id=?").get(peer, clusterId) as { revision: number } | undefined;
    return !ack || ack.revision < stored.revision;
  });
}

/* ---------- evaluation ---------- */

export interface BudgetProject { id: string; type?: string; clusterIds: string[] }
export interface BudgetRule {
  source: "cluster" | "local";
  clusterId?: string;
  kind: BudgetKind;
  /** Workspace id, project id, conversation id, or cluster id. */
  subjectId: string;
  projectId?: string;
  limit: BudgetLimit;
  utcOffsetMinutes: number;
}
export interface BudgetStatus {
  rule: BudgetRule; spentUsd: number; ratio: number; exceeded: boolean; warning: boolean;
  /** When the window rolls over; null for a total, which never does. */
  resetsAt: string | null;
}
/** What the ledger holds for a rule's subject inside a window. */
export type SpendReader = (subject: { kind: BudgetKind; subjectId: string; projectIds: string[]; conversationId?: string }, from: string | undefined, to: string | undefined) => number;

export interface EvaluationInput {
  db: DatabaseSync;
  project: BudgetProject;
  /** Every project known on this node; cluster and workspace spend sums over them. */
  projects: BudgetProject[];
  conversationId?: string;
  spend: SpendReader;
  now?: Date;
}

export function applicableRules(db: DatabaseSync, project: BudgetProject, conversationId?: string): BudgetRule[] {
  ensureBudgetSchema(db);
  const rules: BudgetRule[] = [];
  const add = (rule: Omit<BudgetRule, "limit">, limits: BudgetLimit[]) => { for (const limit of limits) rules.push({ ...rule, limit }); };
  for (const clusterId of project.clusterIds) {
    const stored = getClusterPolicy(db, clusterId);
    if (!stored) continue;
    const { policy } = stored, base = { source: "cluster" as const, clusterId, utcOffsetMinutes: policy.utcOffsetMinutes };
    add({ ...base, kind: "cluster", subjectId: clusterId }, policy.limits);
    add({ ...base, kind: "project", subjectId: project.id }, policy.defaults.project);
    if (project.type) add({ ...base, kind: "workspace", subjectId: project.type }, policy.defaults.workspace);
    if (conversationId) add({ ...base, kind: "conversation", subjectId: conversationId, projectId: project.id }, policy.defaults.conversation);
  }
  const own: LocalLimitSubject[] = [{ kind: "project", subjectId: project.id }];
  if (project.type) own.push({ kind: "workspace", subjectId: project.type });
  if (conversationId) own.push({ kind: "conversation", subjectId: conversationId, projectId: project.id });
  for (const subject of own) {
    add({ source: "local", kind: subject.kind, subjectId: subject.subjectId, projectId: subject.projectId, utcOffsetMinutes: localOffset(db, subject) }, listLocalLimits(db, subject));
  }
  return rules;
}

function subjectProjectIds(rule: BudgetRule, input: EvaluationInput): string[] {
  if (rule.kind === "cluster") return input.projects.filter((project) => project.clusterIds.includes(rule.subjectId)).map((project) => project.id);
  if (rule.kind === "workspace") return input.projects.filter((project) => project.type === rule.subjectId).map((project) => project.id);
  return [input.project.id];
}

export function evaluateBudgets(input: EvaluationInput): BudgetStatus[] {
  const now = input.now ?? new Date();
  return applicableRules(input.db, input.project, input.conversationId).map((rule) => {
    const window = budgetWindow(rule.limit.period, now, rule.utcOffsetMinutes);
    const projectIds = subjectProjectIds(rule, input);
    const spentUsd = projectIds.length ? input.spend({ kind: rule.kind, subjectId: rule.subjectId, projectIds, conversationId: rule.kind === "conversation" ? rule.subjectId : undefined }, rule.limit.period === "total" ? undefined : window.start.toISOString(), window.end?.toISOString()) : 0;
    const ratio = spentUsd / rule.limit.usd;
    return { rule, spentUsd, ratio, exceeded: ratio >= 1, warning: ratio >= WARN_RATIO && ratio < 1, resetsAt: window.end?.toISOString() ?? null };
  }).sort((a, b) => b.ratio - a.ratio);
}

const money = (usd: number) => `$${usd < 100 ? usd.toFixed(2) : Math.round(usd).toLocaleString("en-US")}`;
const PERIOD_NAME: Record<BudgetPeriod, string> = { hour: "hourly", day: "daily", week: "weekly", month: "monthly", year: "yearly", total: "total" };

export function describeBudget(status: BudgetStatus, names: { cluster?: (id: string) => string | undefined; project?: string; workspace?: string } = {}): string {
  const { rule } = status;
  const subject = rule.kind === "cluster" ? `cluster ${names.cluster?.(rule.subjectId) ?? "budget"}` : rule.kind === "project" ? `project ${names.project ?? ""}`.trim() : rule.kind === "workspace" ? `workspace ${names.workspace ?? rule.subjectId}` : "this conversation";
  const reset = status.resetsAt ? ` It resets ${status.resetsAt}.` : "";
  return `Budget reached: the ${PERIOD_NAME[rule.limit.period]} limit of ${money(rule.limit.usd)} for ${subject} is used up (${money(status.spentUsd)} spent).${reset}${rule.source === "cluster" ? " The cluster manager set this limit." : ""}`;
}

/** The first exceeded budget, if any. */
export function firstExceeded(statuses: BudgetStatus[]): BudgetStatus | undefined {
  return statuses.find((status) => status.exceeded);
}
