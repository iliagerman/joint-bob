import os from "node:os";
import { claudeConfigPath } from "../../claude-service.js";
import { getSettings } from "../../settings.js";
import { execFile } from "../../subprocess.js";
const effortIds = ["default", "low", "medium", "high", "xhigh", "max"];
const fallbackModels = [
  ["default", "Default (recommended)"],
  ["opus", "Opus"],
  ["fable", "Fable"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"]
].map(([id, label]) => ({ provider: "claude", id, label, thinkingLevels: effortIds }));
const MODEL_CACHE_MS = 10 * 6e4;
let modelCache;
let reported = [];
function parseCatalogue(entries) {
  if (!Array.isArray(entries)) throw new Error("Invalid Claude model catalogue");
  const models = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const { value, resolvedModel, displayName, supportsEffort, supportedEffortLevels } = entry;
    if (typeof value !== "string" || !value || models.has(value)) continue;
    const levels = supportsEffort === true && Array.isArray(supportedEffortLevels) ? ["default", ...supportedEffortLevels.filter((level) => typeof level === "string" && effortIds.includes(level))] : ["default"];
    models.set(value, {
      provider: "claude",
      id: value,
      label: typeof displayName === "string" && displayName.trim() ? displayName.trim() : value,
      thinkingLevels: levels,
      resolved: typeof resolvedModel === "string" && resolvedModel ? resolvedModel : value
    });
  }
  if (!models.size) throw new Error("Claude reported no models");
  return [...models.values()];
}
function claudeModelsFromCatalogue(entries) {
  return parseCatalogue(entries).map(({ resolved: _resolved, ...model }) => model);
}
function claudeModelLabel(id) {
  const exact = reported.find((model) => model.id === id);
  if (exact) return exact.label;
  const pinned = reported.find((model) => model.resolved === id && model.id !== "default");
  return pinned ? pinned.label : id;
}
async function queryClaudeModels(executable) {
  const configPath = claudeConfigPath();
  const output = await new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      { cwd: os.tmpdir(), env: { ...process.env, ...configPath ? { CLAUDE_CONFIG_DIR: configPath } : {} }, timeout: 2e4, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(String(stdout))
    );
    child.stdin?.on("error", () => {
    });
    child.stdin?.end(`${JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } })}
`);
  });
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    const record = JSON.parse(line);
    if (record.type !== "control_response" || record.response?.request_id !== "models") continue;
    reported = parseCatalogue(record.response.response?.models);
    return reported.map(({ resolved: _resolved, ...model }) => model);
  }
  throw new Error("Claude did not answer the initialize request");
}
async function claudeModels() {
  const executable = getSettings().runtimes.claude.executable || "claude";
  if (!modelCache || modelCache.executable !== executable || Date.now() - modelCache.at > MODEL_CACHE_MS) {
    const models = queryClaudeModels(executable).catch((error) => {
      console.warn("Claude model discovery unavailable", { error: error instanceof Error ? error.message : String(error) });
      modelCache = { executable, at: 0, models: Promise.resolve(fallbackModels) };
      return fallbackModels;
    });
    modelCache = { executable, at: Date.now(), models };
  }
  return modelCache.models;
}
export {
  claudeModelLabel,
  claudeModels,
  claudeModelsFromCatalogue,
  effortIds
};
