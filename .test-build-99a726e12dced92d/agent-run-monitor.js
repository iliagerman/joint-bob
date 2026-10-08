import { describeError } from "./error-description.js";
function record(value) {
  return typeof value === "object" && value !== null ? value : void 0;
}
function text(value) {
  return typeof value === "string" ? value : void 0;
}
function clip(value, max) {
  const trimmed = (text(value) ?? "").trim();
  return trimmed ? trimmed.slice(0, max) : void 0;
}
function status(value) {
  return ["queued", "running", "succeeded", "failed", "cancelled"].includes(String(value)) ? value : void 0;
}
function stateUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(hostname)) return void 0;
    return new URL("/api/state", url.origin).toString();
  } catch {
    return void 0;
  }
}
function reason(task, taskStatus) {
  if (taskStatus !== "failed") return void 0;
  const lines = (text(task?.stderr) ?? "").trim().split("\n");
  const start = lines.findIndex((line) => /^[\w.]*Error\b/.test(line.trim()));
  const trace = (start === -1 ? lines : lines.slice(start)).join("\n").trim();
  const code = task?.exitCode;
  const message = (text(task?.error) ?? "").trim() || trace || (typeof code === "number" && code !== 0 ? `Worker exited with code ${code}` : "");
  return message ? message.slice(0, 500) : void 0;
}
function tasks(value, initial = false) {
  if (!Array.isArray(value)) return void 0;
  const mapped = value.map((item) => {
    const task = record(item);
    const name = text(task?.agent);
    const role = text(task?.role);
    const taskStatus = status(task?.status) ?? (initial && task?.status === void 0 ? "queued" : void 0);
    if (!name || !role || !taskStatus) return void 0;
    const error = reason(task, taskStatus);
    const taskText = clip(task?.task, 300);
    const model = clip(task?.model, 100);
    const finalOutput = clip(task?.finalOutput, 2e3);
    return { name, role, status: taskStatus, ...taskText ? { task: taskText } : {}, ...model ? { model } : {}, ...finalOutput ? { finalOutput } : {}, ...error ? { error } : {} };
  });
  return mapped.every(Boolean) ? mapped : void 0;
}
function summary(run) {
  const runId = text(run.runId) ?? text(run.id);
  const runStatus = status(run.status);
  const runTasks = tasks(run.tasks);
  return runId && runStatus && runTasks ? { runId, status: runStatus, tasks: runTasks } : void 0;
}
function agentRunDescriptor(event) {
  const payload = record(event);
  if (payload?.type !== "tool_execution_end" || payload.toolName !== "multi_agent_run" || payload.isError === true) return void 0;
  const details = record(payload.details) ?? record(record(payload.result)?.details);
  const runId = text(details?.runId);
  const url = text(details?.dashboardUrl);
  const initialTasks = tasks(details?.tasks, true);
  const apiUrl = url && stateUrl(url);
  return runId && apiUrl && initialTasks ? { runId, stateUrl: apiUrl, summary: { runId, status: "running", tasks: initialTasks } } : void 0;
}
async function refreshAgentRun(descriptor) {
  let response;
  try {
    response = await fetch(descriptor.stateUrl, { signal: AbortSignal.timeout(2e3) });
  } catch (error) {
    throw new Error(`Agent dashboard request failed: ${describeError(error)}`);
  }
  if (!response.ok) throw new Error(`Agent dashboard returned ${response.status}`);
  let payload;
  try {
    payload = record(await response.json());
  } catch (error) {
    throw new Error(`Agent dashboard state is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const runs = Array.isArray(payload?.runs) ? payload.runs : void 0;
  if (!runs) throw new Error("Agent dashboard state is malformed");
  const inventory = runs.map(record);
  if (inventory.some((candidate) => !(text(candidate?.runId) ?? text(candidate?.id)))) throw new Error("Agent dashboard state is malformed");
  const run = inventory.find((candidate) => (text(candidate?.runId) ?? text(candidate?.id)) === descriptor.runId);
  if (!run) return {
    ...descriptor.summary,
    status: "failed",
    tasks: descriptor.summary.tasks.map((task) => ["queued", "running"].includes(task.status) ? { ...task, status: "failed", error: `Agent dashboard no longer tracks run ${descriptor.runId}; completion unknown` } : task)
  };
  const parsed = summary(run);
  if (!parsed) throw new Error(`Agent dashboard run ${descriptor.runId} is malformed`);
  return parsed;
}
export {
  agentRunDescriptor,
  refreshAgentRun
};
