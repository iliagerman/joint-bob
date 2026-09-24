import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import type { HarnessAdapter } from "./harnesses/contract.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { configuredRuntime } from "./harnesses/runtime-configuration.js";

const execute = promisify(execFile);
const UPDATE_INTERVAL_MS = 24 * 60 * 60_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;

export type HarnessUpdateState = "idle" | "running" | "succeeded" | "failed" | "unsupported";
export interface HarnessUpdateStatus {
  id: string;
  label: string;
  state: HarnessUpdateState;
  checkedAt: string | null;
  error: string | null;
}

function status(adapter: HarnessAdapter, state: HarnessUpdateState, error: string | null = null): HarnessUpdateStatus {
  return { id: adapter.id, label: adapter.label, state, checkedAt: ["idle", "unsupported"].includes(state) ? null : new Date().toISOString(), error };
}

function updateError(error: unknown): string {
  const failure = error as Error & { stderr?: string };
  return (failure.stderr?.trim() || failure.message || String(error)).slice(0, 2000);
}

export async function runHarnessUpdates(adapters = listDiscoveredHarnesses()): Promise<HarnessUpdateStatus[]> {
  const results: HarnessUpdateStatus[] = [];
  for (const adapter of adapters) {
    const configuration = adapter.configuration;
    if (!configuration?.updateArgs) {
      results.push(status(adapter, "unsupported"));
      continue;
    }
    const runtime = configuredRuntime(adapter.id, configuration.defaults(os.homedir()));
    try {
      await execute(runtime.executable, configuration.updateArgs, {
        cwd: os.homedir(),
        env: process.env,
        timeout: UPDATE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      results.push(status(adapter, "succeeded"));
    } catch (error) {
      results.push(status(adapter, "failed", updateError(error)));
    }
  }
  return results;
}

let current = listDiscoveredHarnesses().map((adapter) => status(adapter, adapter.configuration?.updateArgs ? "idle" : "unsupported"));
let active: Promise<void> | null = null;

export function harnessUpdateStatus(): { running: boolean; harnesses: HarnessUpdateStatus[] } {
  return { running: Boolean(active), harnesses: current.map((entry) => ({ ...entry })) };
}

export function startHarnessUpdates(): { running: boolean; harnesses: HarnessUpdateStatus[] } {
  if (active) return harnessUpdateStatus();
  current = listDiscoveredHarnesses().map((adapter) => status(adapter, adapter.configuration?.updateArgs ? "running" : "unsupported"));
  active = runHarnessUpdates().then((results) => { current = results; }).finally(() => { active = null; });
  return harnessUpdateStatus();
}

let schedulerStarted = false;
export function startHarnessUpdateScheduler(): void {
  if (!/^[0-9a-f]{40}$/i.test(process.env.JOINT_BOB_RELEASE ?? "") || schedulerStarted) return;
  schedulerStarted = true;
  const run = (): void => { if (!active) startHarnessUpdates(); };
  setTimeout(run, 5 * 60_000).unref();
  setInterval(run, UPDATE_INTERVAL_MS).unref();
}
