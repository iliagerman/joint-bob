import { serviceRuntime, signalRuntimeGroup, spawnInRuntime, type RuntimeAccount } from "../account-runtime.js";
import { trackSubprocess } from "../subprocess.js";
import { parsePayload, type DashboardPayload } from "./contract.js";
import { payloadPath, readPayload, stateDirectory, writePayload, writeRunLog, type PayloadTarget } from "./files.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_LOG_BYTES = 64 * 1024;

export type RefreshResult = { ok: true; payload: DashboardPayload } | { ok: false; error: string };

export interface ScriptRefreshInput {
  id: string;
  command: string;
  /** The entity's folder: the project folder, or the workspace folder. */
  cwd: string;
  /** The definition's own folder, where its script files are. */
  definitionDirectory: string;
  /** The entity's secret environment plus whatever the node's commands normally get. */
  env: NodeJS.ProcessEnv;
  runtime?: RuntimeAccount;
  timeoutMs?: number;
  /** "draft" for the creator's test refresh; its data never replaces the live payload. */
  target?: PayloadTarget;
}

function environment(input: ScriptRefreshInput): NodeJS.ProcessEnv {
  const previous = readPayload(input.id, input.target) ? payloadPath(input.id, input.target) : "";
  return {
    ...input.env,
    JOINT_BOB_DASHBOARD_DIR: input.definitionDirectory,
    JOINT_BOB_DASHBOARD_STATE: stateDirectory(input.id),
    JOINT_BOB_DASHBOARD_PREVIOUS: previous,
  };
}

/**
 * Runs a dashboard's refresh script once, with no AI involved. A run that fails in any way
 * leaves the last good payload in place; its output is kept as the run log either way.
 */
export function runScriptRefresh(input: ScriptRefreshInput): Promise<RefreshResult> {
  const runtime = input.runtime ?? serviceRuntime();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = spawnInRuntime(runtime, "/bin/sh", ["-c", input.command], {
    cwd: input.cwd, env: environment(input), detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  trackSubprocess(child);
  child.stdin.end();
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let log = "";
  let failure: string | undefined;
  const stop = (reason: string) => {
    failure ??= reason;
    if (child.pid) void signalRuntimeGroup(runtime, child.pid, "SIGKILL").catch(() => undefined);
  };
  const timer = setTimeout(() => stop(`The refresh script did not finish within ${Math.ceil(timeoutMs / 1000)} s and was stopped`), timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_STDOUT_BYTES) { stop("The refresh script printed more than 4 MiB"); return; }
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => { if (log.length < MAX_LOG_BYTES) log += chunk.toString("utf8"); });
  return new Promise((resolve) => {
    child.on("error", (error) => stop(`The refresh script could not start: ${error.message}`));
    child.on("close", (code) => {
      clearTimeout(timer);
      writeRunLog(input.id, log.slice(0, MAX_LOG_BYTES));
      if (!failure && code !== 0) failure = `The refresh script exited with code ${code}`;
      if (failure) { resolve({ ok: false, error: failure }); return; }
      try {
        const payload = parsePayload(Buffer.concat(stdout).toString("utf8"));
        writePayload(input.id, payload, input.target);
        resolve({ ok: true, payload });
      } catch (error) {
        resolve({ ok: false, error: (error as Error).message });
      }
    });
  });
}
