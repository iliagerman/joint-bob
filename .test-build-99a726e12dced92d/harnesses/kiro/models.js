import { getSettings } from "../../settings.js";
import { execFile } from "../../subprocess.js";
import { promisify } from "node:util";
import { configuredRuntime } from "../runtime-configuration.js";
const execute = promisify(execFile);
const kiroThinkingLevels = ["low", "medium", "high", "xhigh", "max"];
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Kiro ACP ${label}`);
  return value;
}
function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`Invalid Kiro ACP ${label}`);
  return value;
}
async function kiroModels() {
  const settings = configuredRuntime("kiro", getSettings().runtimes.kiro);
  let stdout;
  try {
    ({ stdout } = await execute(settings.executable || "kiro-cli", ["chat", "--list-models", "--format", "json"], {
      env: { ...process.env, KIRO_HOME: settings.configPath },
      timeout: 5e3,
      maxBuffer: 1024 * 1024
    }));
  } catch (error) {
    console.warn("Kiro model discovery unavailable", { code: error.code });
    return [{ provider: "kiro", id: "default", label: "Kiro default", thinkingLevels: kiroThinkingLevels }];
  }
  const catalogue = object(JSON.parse(stdout), "model catalogue");
  if (!Array.isArray(catalogue.models)) throw new Error("Invalid Kiro ACP model catalogue");
  return catalogue.models.map((value) => {
    const model = object(value, "catalogue model");
    return {
      provider: "kiro",
      id: requiredString(model.model_id, "model ID"),
      label: requiredString(model.model_name, "model name"),
      thinkingLevels: kiroThinkingLevels
    };
  });
}
export {
  kiroModels,
  kiroThinkingLevels
};
