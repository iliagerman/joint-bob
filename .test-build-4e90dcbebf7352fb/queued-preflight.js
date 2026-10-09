import { execFile } from "./subprocess.js";
import { promisify } from "node:util";
import { z } from "zod";
import { getSettings } from "./settings.js";
import { claudeConfigPath } from "./claude-service.js";
const execute = promisify(execFile);
async function preflightQueuedClaude(cwd, env) {
  const settings = getSettings().claude;
  const configPath = claudeConfigPath();
  const result = await execute(settings.executable || "claude", ["auth", "status", "--json"], {
    cwd,
    env: { ...process.env, ...env, ...configPath ? { CLAUDE_CONFIG_DIR: configPath } : {} },
    timeout: 1e4,
    maxBuffer: 64 * 1024
  });
  const status = z.object({ loggedIn: z.boolean() }).parse(JSON.parse(result.stdout));
  if (!status.loggedIn) throw new Error("Claude authentication unavailable on this node");
}
export {
  preflightQueuedClaude
};
