import os from "node:os";
import { promisify } from "node:util";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { configuredRuntime } from "./harnesses/runtime-configuration.js";
import { execFile } from "./subprocess.js";

export type SubscriptionDetection = {
  harnessId: string;
  status: "detected" | "unavailable" | "unsupported";
  planName: string | null;
  authMethod: string | null;
  price: null;
  source: string;
  message: string;
  checkedAt: string;
};
type ExecResult = { stdout: string | Buffer; stderr?: string | Buffer };
export type SubscriptionDetectionExec = (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }) => Promise<ExecResult>;
const nativeExec = promisify(execFile) as unknown as SubscriptionDetectionExec;
const bounded = (value: unknown): string | null => typeof value === "string" && value.length <= 120 ? value : null;

export async function detectHarnessSubscription(harness: { id: string; label: string; configuration?: import("./harnesses/runtime-configuration.js").HarnessConfiguration }, execute: SubscriptionDetectionExec = nativeExec): Promise<SubscriptionDetection> {
  const checkedAt = new Date().toISOString();
  const base = { harnessId: harness.id, planName: null, authMethod: null, price: null, source: "harness auth status", checkedAt } as const;
  if (harness.id !== "claude" || !harness.configuration) return { ...base, status: "unsupported", message: "Harness does not expose subscription plan or billed price" };
  try {
    const runtime = configuredRuntime(harness.id, harness.configuration.defaults(os.homedir()));
    const result = await execute(runtime.executable, ["auth", "status", "--json"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: runtime.configPath }, timeout: 5_000, maxBuffer: 64 * 1024,
    });
    const parsed: unknown = JSON.parse(String(result.stdout));
    if (!parsed || typeof parsed !== "object") throw new Error("invalid");
    const value = parsed as Record<string, unknown>;
    const planName = bounded(value.subscriptionType);
    const authMethod = bounded(value.authMethod);
    if (value.loggedIn !== true || !planName) return { ...base, status: "unavailable", authMethod, message: "Claude is not signed in or did not report a subscription type; billed price unavailable" };
    return { ...base, status: "detected", planName, authMethod, message: "Reported by Claude authentication status; billed price unavailable" };
  } catch {
    return { ...base, status: "unavailable", message: "Harness authentication status unavailable; billed price unavailable" };
  }
}

export function createSubscriptionDetectionCollector(execute: SubscriptionDetectionExec = nativeExec, ttlMs = 60_000) {
  let cached: { at: number; detections: SubscriptionDetection[] } | undefined;
  let inFlight: Promise<SubscriptionDetection[]> | undefined;
  return async (): Promise<SubscriptionDetection[]> => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.detections;
    if (inFlight) return inFlight;
    inFlight = Promise.all(listDiscoveredHarnesses().map((harness) => detectHarnessSubscription(harness, execute)))
      .then((detections) => { cached = { at: Date.now(), detections }; return detections; })
      .finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
export const collectSubscriptionDetections = createSubscriptionDetectionCollector();
