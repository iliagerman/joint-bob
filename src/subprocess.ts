import { execFile as nativeExecFile, spawn as nativeSpawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { watchSubprocess } from "../scripts/subprocess-lifetime.mjs";
import { resolveDataDirectory } from "./data-directory.js";

/** Register at launch, never from a persisted PID or a machine-wide process search. */
export function trackSubprocess(child: ChildProcess): void {
  watchSubprocess(child, { dataDirectory: resolveDataDirectory() });
}

export const spawn: typeof nativeSpawn = ((...args: Parameters<typeof nativeSpawn>) => {
  const child = nativeSpawn(...args);
  trackSubprocess(child);
  return child;
}) as typeof nativeSpawn;

export const execFile: typeof nativeExecFile = ((...args: unknown[]) => {
  const child = Reflect.apply(nativeExecFile, undefined, args) as ChildProcess;
  trackSubprocess(child);
  return child;
}) as typeof nativeExecFile;

// Preserve Node's special execFile promise result and .child handle.
Object.defineProperty(execFile, promisify.custom, { value: (...args: unknown[]) => {
  let child: ChildProcess;
  const promise = new Promise((resolve, reject) => {
    child = Reflect.apply(execFile, undefined, [...args, (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    }]);
  });
  return Object.assign(promise, { child: child! });
} });
