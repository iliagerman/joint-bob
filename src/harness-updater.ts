import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import type { HarnessAdapter } from "./harnesses/contract.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { configuredRuntime, type HarnessUpdateInstructions } from "./harnesses/runtime-configuration.js";
import { resolveDataDirectory } from "./data-directory.js";

const execute = promisify(execFile);
const UPDATE_INTERVAL_MS = 24 * 60 * 60_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";

export type HarnessUpdateState = "idle" | "running" | "succeeded" | "failed" | "unsupported";
export interface HarnessUpdateStatus {
  id: string;
  label: string;
  state: HarnessUpdateState;
  checkedAt: string | null;
  error: string | null;
}

interface UpdateCommand {
  executable: string;
  args: string[];
  cwd: string;
}

function status(adapter: HarnessAdapter, state: HarnessUpdateState, error: string | null = null): HarnessUpdateStatus {
  return { id: adapter.id, label: adapter.label, state, checkedAt: ["idle", "unsupported"].includes(state) ? null : new Date().toISOString(), error };
}

function updateError(error: unknown): string {
  const failure = error as Error & { stderr?: string };
  return (failure.stderr?.trim() || failure.message || String(error)).slice(0, 2000);
}

function managedHarnessRoot(id: string): string {
  return path.join(resolveDataDirectory(), "harnesses", id);
}

function activateManagedHarness(id: string): void {
  const bin = path.join(managedHarnessRoot(id), "node_modules", ".bin");
  if (!existsSync(bin)) return;
  const current = (process.env.PATH ?? "").split(path.delimiter).filter((entry) => entry && entry !== bin);
  process.env.PATH = [bin, ...current].join(path.delimiter);
}

export function activateManagedHarnesses(adapters = listDiscoveredHarnesses()): void {
  for (const adapter of adapters) if (adapter.configuration?.update?.type === "npm") activateManagedHarness(adapter.id);
}

export function harnessUpdateCommand(id: string, executable: string, instructions: HarnessUpdateInstructions): UpdateCommand {
  if (instructions.type === "self") return { executable, args: instructions.args, cwd: os.homedir() };
  const installRoot = managedHarnessRoot(id);
  return {
    executable: "npm",
    args: ["install", "--prefix", installRoot, "--no-save", "--package-lock=false", "--omit=dev", `--registry=${PUBLIC_NPM_REGISTRY}`, `${instructions.packageName}@latest`],
    cwd: installRoot,
  };
}

export async function runHarnessUpdates(adapters = listDiscoveredHarnesses()): Promise<HarnessUpdateStatus[]> {
  const results: HarnessUpdateStatus[] = [];
  for (const adapter of adapters) {
    const configuration = adapter.configuration;
    if (!configuration?.update) {
      results.push(status(adapter, "unsupported"));
      continue;
    }
    const runtime = configuredRuntime(adapter.id, configuration.defaults(os.homedir()));
    try {
      const command = harnessUpdateCommand(adapter.id, runtime.executable, configuration.update);
      if (configuration.update.type === "npm") mkdirSync(command.cwd, { recursive: true });
      await execute(command.executable, command.args, {
        cwd: command.cwd,
        env: process.env,
        timeout: UPDATE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      if (configuration.update.type === "npm") activateManagedHarness(adapter.id);
      results.push(status(adapter, "succeeded"));
    } catch (error) {
      results.push(status(adapter, "failed", updateError(error)));
    }
  }
  return results;
}

let current = listDiscoveredHarnesses().map((adapter) => status(adapter, adapter.configuration?.update ? "idle" : "unsupported"));
let active: Promise<void> | null = null;

export function harnessUpdateStatus(): { running: boolean; harnesses: HarnessUpdateStatus[] } {
  return { running: Boolean(active), harnesses: current.map((entry) => ({ ...entry })) };
}

export function startHarnessUpdates(): { running: boolean; harnesses: HarnessUpdateStatus[] } {
  if (active) return harnessUpdateStatus();
  current = listDiscoveredHarnesses().map((adapter) => status(adapter, adapter.configuration?.update ? "running" : "unsupported"));
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
