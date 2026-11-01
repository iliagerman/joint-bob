import { guardianHookEnvironment, guardianHookScript } from "./agent-token.js";
import { checkGuardian, guardianStartProblem } from "./check.js";
import { guardianGroups } from "./settings.js";

export interface ClaudeGuardianRun { prompt: string; env: NodeJS.ProcessEnv; hooks: Record<string, unknown[]> }

// Longer than a review waits, so Claude never times the hook out (a timed-out hook lets the call run).
const HOOK_TIMEOUT_SECONDS = 15 * 60;

/**
 * Guardian for one Claude turn. The person's message is checked here, before Claude sees it. Tool
 * calls are checked by a PreToolUse hook, added only while a rule checks tool calls.
 */
export async function prepareClaudeGuardian(projectId: string, conversationId: string, cwd: string, prompt: string): Promise<ClaudeGuardianRun> {
  const problem = await guardianStartProblem("claude");
  if (problem) throw new Error(problem);
  const verdict = await checkGuardian({ projectId, conversationId, harness: "claude", cwd, canReplaceTool: true }, { kind: "outgoing", source: "the user's message", text: prompt });
  if (verdict.action === "block") throw new Error(verdict.reason);
  const checked = verdict.action === "replace" && verdict.text !== undefined ? verdict.text : prompt;
  const checksTools = (await guardianGroups()).some((group) => group.rules.some((rule) => rule.enabled && rule.check !== "outgoing"));
  if (!checksTools) return { prompt: checked, env: {}, hooks: {} };
  return {
    prompt: checked,
    env: guardianHookEnvironment(projectId, conversationId, cwd),
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(guardianHookScript())}`, timeout: HOOK_TIMEOUT_SECONDS }] }] },
  };
}
