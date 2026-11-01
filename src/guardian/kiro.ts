import { checkGuardian, guardianStartProblem, type GuardianIdentity } from "./check.js";
import { toolCategory, type ToolCategory } from "./rules.js";
import { guardianGroups } from "./settings.js";

type JsonObject = Record<string, unknown>;

/** While any rule checks tool calls, Kiro must ask before every call instead of trusting its tools. */
export async function kiroChecksTools(): Promise<boolean> {
  return (await guardianGroups()).some((group) => group.rules.some((rule) => rule.enabled && rule.check !== "outgoing"));
}

/** The prompt Kiro may send, after Guardian; throws when Guardian withholds it. */
export async function guardKiroPrompt(identity: GuardianIdentity, text: string): Promise<string> {
  const problem = await guardianStartProblem("kiro");
  if (problem) throw new Error(problem);
  const verdict = await checkGuardian(identity, { kind: "outgoing", source: "the user's message", text });
  if (verdict.action === "block") throw new Error(verdict.reason);
  return verdict.action === "replace" && verdict.text !== undefined ? verdict.text : text;
}

/** ACP names what a tool does; Kiro's own tool name is the fallback. */
function category(kind: unknown, toolName: string): ToolCategory {
  if (kind === "execute") return "commands";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file-changes";
  return toolCategory(toolName);
}

/**
 * Guardian's answer to Kiro's permission request. Kiro can only allow or reject a call, so a rule
 * that would change the arguments asks the person instead.
 */
export async function kiroPermission(identity: GuardianIdentity, request: JsonObject, known: { toolName: string; rawInput: unknown } | undefined): Promise<JsonObject> {
  const toolCall = (request.toolCall ?? {}) as JsonObject;
  const toolName = known?.toolName ?? (typeof toolCall.title === "string" ? toolCall.title : "tool");
  const rawInput = known?.rawInput ?? toolCall.rawInput;
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput as JsonObject : { value: rawInput ?? null };
  const verdict = await checkGuardian(identity, { kind: "tool", tool: toolName, category: category(toolCall.kind, toolName), input });
  const wanted = verdict.action === "block" ? "reject_once" : "allow_once";
  const options = Array.isArray(request.options) ? request.options as JsonObject[] : [];
  const option = options.find((item) => item.kind === wanted && typeof item.optionId === "string");
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
}
