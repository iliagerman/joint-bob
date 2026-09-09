import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { getSettings } from "./settings.js";

const execute = promisify(execFile);

export async function preflightQueuedClaude(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const settings = getSettings().claude;
  const result = await execute(settings.executable || "claude", ["auth", "status", "--json"], {
    cwd, env: { ...process.env, ...env, ...(settings.configPath ? { CLAUDE_CONFIG_DIR: settings.configPath } : {}) },
    timeout: 10_000, maxBuffer: 64 * 1024,
  });
  const status = z.object({ loggedIn: z.boolean() }).parse(JSON.parse(result.stdout));
  if (!status.loggedIn) throw new Error("Claude authentication unavailable on this node");
}
