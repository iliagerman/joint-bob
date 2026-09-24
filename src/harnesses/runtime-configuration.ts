import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import type { RuntimeSettings } from "../settings.js";
import { value } from "../settings-store.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type HarnessUpdateInstructions =
  | { type: "self"; args: string[] }
  | { type: "npm"; packageName: string };

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

export function configuredRuntime(id: string, defaults: RuntimeSettings): RuntimeSettings {
  const overrides = runtimeOverrides(id);
  return {
    executable: overrides.executable || defaults.executable,
    configPath: overrides.configPath || defaults.configPath,
    sessionPath: overrides.sessionPath || defaults.sessionPath,
  };
}

export function detectExecutable(command: string): string {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try { accessSync(candidate, fsConstants.X_OK); return candidate; }
    catch (error) {
      if (!["EACCES", "ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return command;
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
