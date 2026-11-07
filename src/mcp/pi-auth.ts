import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnInRuntime, runtimeEnvironment, type RuntimeAccount } from "../account-runtime.js";
import { piSdkEntry } from "../pi-sdk.js";
import type { ManagedMcpServer } from "./store.js";

/** Definitions travel over private stdin, never command arguments or replicated files. */
export function spawnPiMcpControl(context: { runtime: RuntimeAccount; cwd: string; directory: string; servers: Record<string, ManagedMcpServer> }) {
  const here = fileURLToPath(import.meta.url);
  const worker = path.join(path.dirname(here), `pi-auth-worker.${here.endsWith(".ts") ? "ts" : "js"}`);
  const args = here.endsWith(".ts") ? ["--import", import.meta.resolve("tsx"), worker] : [worker];
  const child = spawnInRuntime(context.runtime, process.execPath, args, {
    cwd: context.cwd, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    env: runtimeEnvironment(context.runtime, { ...process.env, JOINT_BOB_PI_WORKER: "1", JOINT_BOB_PI_SDK_ENTRY: piSdkEntry ?? "" }),
  });
  child.stdin.on("error", () => {});
  child.stdin.write(`${JSON.stringify({ type: "configure", cwd: context.cwd, directory: context.directory, servers: context.servers })}\n`);
  return child;
}
