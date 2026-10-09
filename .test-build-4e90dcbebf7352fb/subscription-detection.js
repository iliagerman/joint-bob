import os from "node:os";
import { promisify } from "node:util";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { configuredRuntime } from "./harnesses/runtime-configuration.js";
import { execFile } from "./subprocess.js";
const nativeExec = promisify(execFile);
const bounded = (value) => typeof value === "string" && value.length <= 120 ? value : null;
async function detectHarnessSubscription(harness, execute = nativeExec) {
  const checkedAt = (/* @__PURE__ */ new Date()).toISOString();
  const base = { harnessId: harness.id, planName: null, authMethod: null, price: null, source: "harness auth status", checkedAt };
  if (harness.id !== "claude" || !harness.configuration) return { ...base, status: "unsupported", message: "Harness does not expose subscription plan or billed price" };
  try {
    const runtime = configuredRuntime(harness.id, harness.configuration.defaults(os.homedir()));
    const result = await execute(runtime.executable, ["auth", "status", "--json"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: runtime.configPath },
      timeout: 5e3,
      maxBuffer: 64 * 1024
    });
    const parsed = JSON.parse(String(result.stdout));
    if (!parsed || typeof parsed !== "object") throw new Error("invalid");
    const value = parsed;
    const planName = bounded(value.subscriptionType);
    const authMethod = bounded(value.authMethod);
    if (value.loggedIn !== true || !planName) return { ...base, status: "unavailable", authMethod, message: "Claude is not signed in or did not report a subscription type; billed price unavailable" };
    return { ...base, status: "detected", planName, authMethod, message: "Reported by Claude authentication status; billed price unavailable" };
  } catch {
    return { ...base, status: "unavailable", message: "Harness authentication status unavailable; billed price unavailable" };
  }
}
function createSubscriptionDetectionCollector(execute = nativeExec, ttlMs = 6e4) {
  let cached;
  let inFlight;
  return async () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.detections;
    if (inFlight) return inFlight;
    inFlight = Promise.all(listDiscoveredHarnesses().map((harness) => detectHarnessSubscription(harness, execute))).then((detections) => {
      cached = { at: Date.now(), detections };
      return detections;
    }).finally(() => {
      inFlight = void 0;
    });
    return inFlight;
  };
}
const collectSubscriptionDetections = createSubscriptionDetectionCollector();
export {
  collectSubscriptionDetections,
  createSubscriptionDetectionCollector,
  detectHarnessSubscription
};
