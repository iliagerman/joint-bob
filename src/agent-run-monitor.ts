import type { AgentRunSummary, AgentRunTaskSummary } from "./types.js";

export interface AgentRunDescriptor { runId: string; stateUrl: string; summary: AgentRunSummary }
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined { return typeof value === "object" && value !== null ? value as RecordValue : undefined; }
function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function status(value: unknown): AgentRunTaskSummary["status"] | undefined {
  return ["queued", "running", "succeeded", "failed", "cancelled"].includes(String(value)) ? value as AgentRunTaskSummary["status"] : undefined;
}
function stateUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(hostname)) return undefined;
    return new URL("/api/state", url.origin).toString();
  } catch {
    return undefined;
  }
}
function tasks(value: unknown, initial = false): AgentRunTaskSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const mapped = value.map((item) => {
    const task = record(item); const name = text(task?.agent); const role = text(task?.role);
    const taskStatus = status(task?.status) ?? (initial && task?.status === undefined ? "queued" : undefined);
    return name && role && taskStatus ? { name, role, status: taskStatus } : undefined;
  });
  return mapped.every(Boolean) ? mapped as AgentRunTaskSummary[] : undefined;
}
function summary(run: RecordValue): AgentRunSummary | undefined {
  const runId = text(run.runId) ?? text(run.id); const runStatus = status(run.status); const runTasks = tasks(run.tasks);
  return runId && runStatus && runTasks ? { runId, status: runStatus, tasks: runTasks } : undefined;
}

export function agentRunDescriptor(event: unknown): AgentRunDescriptor | undefined {
  const payload = record(event);
  if (payload?.type !== "tool_execution_end" || payload.toolName !== "multi_agent_run" || payload.isError === true) return undefined;
  const details = record(payload.details) ?? record(record(payload.result)?.details);
  const runId = text(details?.runId); const url = text(details?.dashboardUrl); const initialTasks = tasks(details?.tasks, true);
  const apiUrl = url && stateUrl(url);
  return runId && apiUrl && initialTasks ? { runId, stateUrl: apiUrl, summary: { runId, status: "running", tasks: initialTasks } } : undefined;
}

export async function refreshAgentRun(descriptor: AgentRunDescriptor): Promise<AgentRunSummary> {
  let response: Response;
  try {
    response = await fetch(descriptor.stateUrl, { signal: AbortSignal.timeout(2_000) });
  } catch (error) {
    throw new Error(`Agent dashboard request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`Agent dashboard returned ${response.status}`);
  let payload: RecordValue | undefined;
  try {
    payload = record(await response.json());
  } catch (error) {
    throw new Error(`Agent dashboard state is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const runs = Array.isArray(payload?.runs) ? payload.runs : undefined;
  if (!runs) throw new Error("Agent dashboard state is malformed");
  const run = runs.map(record).find((candidate) => (text(candidate?.runId) ?? text(candidate?.id)) === descriptor.runId);
  const parsed = run && summary(run);
  if (!parsed) throw new Error(`Agent dashboard run ${descriptor.runId} was not found`);
  return parsed;
}
