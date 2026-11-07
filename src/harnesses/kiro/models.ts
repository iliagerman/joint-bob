import { getSettings } from "../../settings.js";
import { execFile } from "../../subprocess.js";
import { promisify } from "node:util";
import { configuredRuntime } from "../runtime-configuration.js";
import type { HarnessModel } from "../runtime.js";

const execute = promisify(execFile);
export const kiroThinkingLevels = ["low", "medium", "high", "xhigh", "max"];

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Kiro ACP ${label}`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid Kiro ACP ${label}`);
  return value;
}

export async function kiroModels(): Promise<HarnessModel[]> {
  if (!getSettings().kiroEnabled) return [];
  const settings = configuredRuntime("kiro", getSettings().runtimes.kiro);
  const executable = settings.executable || "kiro-cli";
  const options = { env: { ...process.env, KIRO_HOME: settings.configPath, KIRO_NO_AUTO_UPDATE: "1" }, timeout: 5_000, maxBuffer: 1024 * 1024 };
  let stdout: string;
  try {
    // Background discovery must never launch browser sign-in. Authentication is a user action.
    await execute(executable, ["whoami"], options);
    ({ stdout } = await execute(executable, ["chat", "--no-interactive", "--list-models", "--format", "json"], options));
  } catch (error) {
    console.warn("Kiro model discovery unavailable", { code: (error as NodeJS.ErrnoException).code });
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
      thinkingLevels: kiroThinkingLevels,
    };
  });
}
