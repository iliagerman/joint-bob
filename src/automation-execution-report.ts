import type { DatabaseSync } from "node:sqlite";
import { automationExecutions, ensureAutomationExecutionSchema, type AutomationExecution } from "./automation-executions.js";
import { usageEventSchema } from "./usage-types.js";

export interface ExecutionFilters {
  workspaceId: string; tagKey?: string; sourceKind?: "scheduled" | "webhook"; sourceId?: string;
  status?: AutomationExecution["status"]; from: string; to: string; timeZone: string; page: number; pageSize: number;
}
export interface ExecutionStatistics {
  executions: number; conversations: number; queued: number; running: number; succeeded: number; failed: number; cancelled: number; interrupted: number;
  successRate: number | null; averageDurationMs: number | null; tokens: number; costUsd: number; pricedExecutions: number; missingUsage: number;
}
export interface DailyExecutionCount { day: string; count: number }
export interface TagExecutionSummary { key: string; name: string; executions: number }
export interface AutomationExecutionReport { rows: AutomationExecution[]; total: number; statistics: ExecutionStatistics; trend: DailyExecutionCount[]; tags: TagExecutionSummary[]; sources: Array<{ id: string; name: string; kind: "scheduled" | "webhook" }> }

function dayKey(time: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(time));
  return `${parts.find(part => part.type === "year")!.value}-${parts.find(part => part.type === "month")!.value}-${parts.find(part => part.type === "day")!.value}`;
}

export function queryAutomationExecutions(db: DatabaseSync, filters: ExecutionFilters, accessibleProjectIds: string[]): AutomationExecutionReport {
  ensureAutomationExecutionSchema(db);
  new Intl.DateTimeFormat("en", { timeZone: filters.timeZone });
  const projects = new Set(accessibleProjectIds);
  const matches = automationExecutions(db, filters.workspaceId).filter(item => projects.has(item.projectId)
    && item.acceptedAt >= filters.from && item.acceptedAt < filters.to
    && (!filters.tagKey || item.tags.some(tag => tag.key === filters.tagKey))
    && (!filters.sourceKind || item.sourceKind === filters.sourceKind)
    && (!filters.sourceId || item.sourceId === filters.sourceId)
    && (!filters.status || item.status === filters.status));
  const usageDb = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_usage_events'").get() ? db : undefined;
  const costs: number[] = [], durations: number[] = [], trend = new Map<string, number>();
  let tokens = 0, missingUsage = 0, pricedExecutions = 0;
  if (usageDb) {
    const usageQuery = usageDb.prepare("SELECT payload FROM model_usage_events WHERE project_id=? AND json_extract(payload,'$.requestId')=?");
    for (const execution of matches) {
      const rows = usageQuery.all(execution.projectId, execution.requestId) as Array<{ payload: string }>;
      if (!rows.length) { missingUsage++; continue; }
      let hasCost = false;
      for (const row of rows) {
        const event = usageEventSchema.parse(JSON.parse(row.payload));
        for (const value of [event.input, event.output, event.cacheRead, event.cacheWrite5m, event.cacheWrite1h]) if (value !== null) tokens += value;
        if (event.apiCostUsd !== null) { costs.push(event.apiCostUsd); hasCost = true; }
      }
      if (hasCost) pricedExecutions++;
      else missingUsage++;
    }
  } else missingUsage = matches.length;
  for (const execution of matches) {
    const day = dayKey(execution.acceptedAt, filters.timeZone);
    trend.set(day, (trend.get(day) ?? 0) + 1);
    if (["succeeded", "failed"].includes(execution.status) && execution.startedAt && execution.finishedAt) durations.push(Date.parse(execution.finishedAt) - Date.parse(execution.startedAt));
  }
  const count = (status: AutomationExecution["status"]) => matches.filter(item => item.status === status).length;
  const successes = count("succeeded"), failures = count("failed"), settled = successes + failures;
  const statistics: ExecutionStatistics = {
    executions: matches.length, conversations: new Set(matches.map(item => item.sessionId).filter((id): id is string => Boolean(id))).size,
    queued: count("queued"), running: count("running"), succeeded: successes, failed: failures, cancelled: count("cancelled"), interrupted: count("interrupted"),
    successRate: settled ? successes / settled : null, averageDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    tokens, costUsd: costs.reduce((sum, value) => sum + value, 0), pricedExecutions, missingUsage,
  };
  const tagCounts = new Map<string, TagExecutionSummary>();
  for (const execution of matches) for (const tag of execution.tags) {
    const summary = tagCounts.get(tag.key) ?? { key: tag.key, name: tag.name, executions: 0 };
    summary.executions++;
    tagCounts.set(tag.key, summary);
  }
  const start = (filters.page - 1) * filters.pageSize;
  const sources = [...new Map(matches.map(item => [`${item.sourceKind}:${item.sourceId}`, { id: item.sourceId, name: item.sourceName, kind: item.sourceKind }])).values()];
  return { rows: matches.slice(start, start + filters.pageSize), total: matches.length, statistics, trend: [...trend].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count })), tags: [...tagCounts.values()].sort((a, b) => a.name.localeCompare(b.name)), sources };
}
