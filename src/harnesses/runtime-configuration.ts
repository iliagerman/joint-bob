import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import type { RuntimeSettings } from "../settings.js";
import { value } from "../settings-store.js";
import { confinedToRuntime, currentRuntime, usingServiceRuntime } from "../account-runtime.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type HarnessUpdateInstructions =
  | { type: "self"; args: string[] }
  | { type: "npm"; packageName: string; binaryName: string };

export interface HarnessConfiguration {
  defaults(homePath: string): RuntimeSettings;
  thinkingLevels: ThinkingLevel[];
  fixedProvider?: string;
  update?: HarnessUpdateInstructions;
  restartFields: Array<keyof RuntimeSettings>;
}

export function runtimeOverrides(id: string): RuntimeSettings {
  return { executable: value(`${id}.executable`), configPath: value(`${id}.configPath`), sessionPath: value(`${id}.sessionPath`) };
}

/** The node's path overrides point into the service account's home, so a person's own
    runtime always uses the defaults under their own home; the executable stays the node's. */
export function configuredRuntime(id: string, defaults: RuntimeSettings): RuntimeSettings {
  const overrides = runtimeOverrides(id);
  const service = usingServiceRuntime();
  return {
    executable: overrides.executable || defaults.executable,
    configPath: (service && overrides.configPath) || confined(defaults.configPath),
    sessionPath: (service && overrides.sessionPath) || confined(defaults.sessionPath),
  };
}

/** The service reads a person's harness folders for them. One they turned into a link out of
    their home reads as missing, so the server never reads someone else's files through it. */
const REFUSED = "/nonexistent/joint-bob-refused-link";
const checked = new Map<string, { confined: boolean; at: number }>();
function confined(folder: string): string {
  if (!folder || usingServiceRuntime()) return folder;
  const runtime = currentRuntime();
  const key = `${runtime.home}\n${folder}`;
  let entry = checked.get(key);
  if (!entry || Date.now() - entry.at > 2000) {
    entry = { confined: confinedToRuntime(runtime, folder), at: Date.now() };
    checked.set(key, entry);
  }
  return entry.confined ? folder : path.join(REFUSED, path.basename(folder));
}

/** Harness defaults resolve their executable whenever a transcript root is read, once per
    listed file, and each lookup is a syscall per PATH directory. */
const DETECT_TTL_MS = 30_000;
const detected = new Map<string, { executable: string; at: number }>();

export function detectExecutable(command: string): string {
  const key = `${command}\n${process.env.PATH ?? ""}`;
  const cached = detected.get(key);
  if (cached && Date.now() - cached.at < DETECT_TTL_MS) return cached.executable;
  let executable = command;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try { accessSync(candidate, fsConstants.X_OK); executable = candidate; break; }
    catch (error) {
      if (!["EACCES", "ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  detected.set(key, { executable, at: Date.now() });
  return executable;
}

export function localizeTranscript(sessionPath: string, homePath: string, root: string, prefix: string, label: string): string {
  const sourcePath = (prefix ? sessionPath.slice(prefix.length) : sessionPath).replace(/\\/g, "/");
  const segments = sourcePath.split("/");
  const rootIndex = segments.lastIndexOf(root);
  if (rootIndex === -1) throw new Error(`${label} conversation path is outside the synchronized ${root} root`);
  const suffix = segments.slice(rootIndex + 1);
  if (!suffix.length) throw new Error(`${label} conversation path has no session file`);
  if (suffix.some((segment) => !segment || segment === "." || segment === "..")) throw new Error(`${label} conversation path has an invalid session segment`);
  return prefix + path.join(path.resolve(homePath), root, ...suffix);
}
