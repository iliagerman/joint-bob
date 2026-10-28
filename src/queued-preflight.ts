import { claudeSubscriptionEnvironment, runtimeExec, usingServiceRuntime } from "./account-runtime.js";
import { execFile } from "./subprocess.js";
import { promisify } from "node:util";
import { z } from "zod";
import { getSettings } from "./settings.js";
import { claudeConfigPath } from "./claude-service.js";
import { selectedClaudeEnvironment } from "./provider-profiles/execution.js";

const execute = promisify(execFile);

export async function preflightQueuedClaude(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const settings = getSettings().claude;
  const configPath = claudeConfigPath();
  // The CLI obeys the settings it finds in the person's folders, so it runs as that person.
  const launch = runtimeExec(settings.executable || "claude", ["auth", "status", "--json"], selectedClaudeEnvironment({ ...process.env, ...env, ...(configPath ? { CLAUDE_CONFIG_DIR: configPath } : {}), ...claudeSubscriptionEnvironment() }));
  const result = await execute(launch.command, launch.args, {
    cwd: usingServiceRuntime() ? cwd : undefined, env: launch.env,
    timeout: 10_000, maxBuffer: 64 * 1024,
  });
  const status = z.object({ loggedIn: z.boolean() }).parse(JSON.parse(result.stdout));
  if (!status.loggedIn) throw new Error("Claude authentication unavailable on this node");
}
