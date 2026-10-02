import os from "node:os";
import { claudeConfigPath } from "../../claude-service.js";
import { getSettings } from "../../settings.js";
import { execFile } from "../../subprocess.js";
import type { HarnessModel } from "../runtime.js";

export const effortIds = ["default", "low", "medium", "high", "xhigh", "max"];
type ClaudeModel = HarnessModel & { provider: "claude" };
// Used only when the installed CLI cannot report its own catalogue; the aliases always track the newest release.
const fallbackModels: ClaudeModel[] = [
  ["default", "Default (recommended)"], ["opus", "Opus"], ["fable", "Fable"], ["sonnet", "Sonnet"], ["haiku", "Haiku"],
].map(([id, label]) => ({ provider: "claude", id, label, thinkingLevels: effortIds }));
const MODEL_CACHE_MS = 10 * 60_000;
let modelCache: { executable: string; at: number; models: Promise<ClaudeModel[]> } | undefined;
/** The last catalogue the CLI reported, with the pinned model each entry resolves to. */
let reported: Array<ClaudeModel & { resolved: string }> = [];

function parseCatalogue(entries: unknown): Array<ClaudeModel & { resolved: string }> {
  if (!Array.isArray(entries)) throw new Error("Invalid Claude model catalogue");
  const models = new Map<string, ClaudeModel & { resolved: string }>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const { value, resolvedModel, displayName, supportsEffort, supportedEffortLevels } = entry as Record<string, unknown>;
    if (typeof value !== "string" || !value || models.has(value)) continue;
    const levels = supportsEffort === true && Array.isArray(supportedEffortLevels)
      ? ["default", ...supportedEffortLevels.filter((level): level is string => typeof level === "string" && effortIds.includes(level))]
      : ["default"];
    models.set(value, {
      provider: "claude",
      id: value,
      label: typeof displayName === "string" && displayName.trim() ? displayName.trim() : value,
      thinkingLevels: levels,
      resolved: typeof resolvedModel === "string" && resolvedModel ? resolvedModel : value,
    });
  }
  if (!models.size) throw new Error("Claude reported no models");
  return [...models.values()];
}

/** Mirrors the CLI's `/model` picker: same entries, order, names, and effort levels. */
export function claudeModelsFromCatalogue(entries: unknown): ClaudeModel[] {
  return parseCatalogue(entries).map(({ resolved: _resolved, ...model }) => model);
}

/** The CLI's name for a model ID, including pinned IDs that an alias resolves to. */
export function claudeModelLabel(id: string): string {
  const exact = reported.find((model) => model.id === id);
  if (exact) return exact.label;
  const pinned = reported.find((model) => model.resolved === id && model.id !== "default");
  return pinned ? pinned.label : id;
}

async function queryClaudeModels(executable: string): Promise<ClaudeModel[]> {
  const configPath = claudeConfigPath();
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      executable,
      ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      { cwd: os.tmpdir(), env: { ...process.env, ...(configPath ? { CLAUDE_CONFIG_DIR: configPath } : {}) }, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
    // A CLI that exits before reading its input breaks the pipe; the callback already reports that run.
    child.stdin?.on("error", () => {});
    child.stdin?.end(`${JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } })}\n`);
  });
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    const record = JSON.parse(line) as { type?: string; response?: { request_id?: string; response?: { models?: unknown } } };
    if (record.type !== "control_response" || record.response?.request_id !== "models") continue;
    reported = parseCatalogue(record.response.response?.models);
    return reported.map(({ resolved: _resolved, ...model }) => model);
  }
  throw new Error("Claude did not answer the initialize request");
}

/** The installed CLI's model catalogue, refreshed every few minutes so new releases appear without an app update. */
export async function claudeModels(): Promise<ClaudeModel[]> {
  const executable = getSettings().runtimes.claude.executable || "claude";
  if (!modelCache || modelCache.executable !== executable || Date.now() - modelCache.at > MODEL_CACHE_MS) {
    const models = queryClaudeModels(executable).catch((error: unknown) => {
      console.warn("Claude model discovery unavailable", { error: error instanceof Error ? error.message : String(error) });
      modelCache = { executable, at: 0, models: Promise.resolve(fallbackModels) };
      return fallbackModels;
    });
    modelCache = { executable, at: Date.now(), models };
  }
  return modelCache.models;
}
