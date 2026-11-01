import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { GuardianVerdict } from "./check.js";
import { toolCategory, type GuardianRequest } from "./rules.js";

type Check = (request: GuardianRequest) => Promise<GuardianVerdict>;

/** A check that throws is a check that failed: the content is withheld, never sent unchecked. */
async function verdictOf(check: Check, request: GuardianRequest): Promise<GuardianVerdict> {
  try { return await check(request); }
  catch (error) { return { action: "block", reason: `Guardian could not check this, so it was withheld. ${(error as Error).message}` }; }
}

/**
 * Guardian inside a Pi session. It runs in the session's own process (a worker in multi-user mode),
 * so every decision is a call back to the server through `check`.
 */
export function guardianPiExtension(check: Check): InlineExtension {
  const factory: ExtensionFactory = (pi) => {
    // Before a tool runs: block it, or change its arguments in place (Pi reads the same object).
    pi.on("tool_call", async (event) => {
      const input = event.input as Record<string, unknown>;
      const verdict = await verdictOf(check, { kind: "tool", tool: event.toolName, category: toolCategory(event.toolName), input });
      if (verdict.action === "block") return { block: true, reason: verdict.reason };
      if (verdict.action === "replace" && verdict.input) {
        for (const key of Object.keys(input)) delete input[key];
        Object.assign(input, verdict.input);
      }
      return undefined;
    });
    // A tool's output goes to the model next. Pi logs and ignores errors here, so none may escape.
    pi.on("tool_result", async (event) => {
      const text = event.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
      if (!text.trim()) return undefined;
      const verdict = await verdictOf(check, { kind: "outgoing", source: `the output of ${event.toolName}`, text });
      if (verdict.action === "continue") return undefined;
      const images = event.content.filter((part) => part.type === "image");
      return verdict.action === "block"
        ? { content: [{ type: "text" as const, text: verdict.reason }], isError: true }
        : { content: [{ type: "text" as const, text: verdict.text ?? text }, ...images] };
    });
    // A person's message, before it reaches the model.
    pi.on("input", async (event) => {
      if (!event.text.trim()) return { action: "continue" as const };
      const verdict = await verdictOf(check, { kind: "outgoing", source: "the user's message", text: event.text });
      if (verdict.action === "continue") return { action: "continue" as const };
      const text = verdict.action === "block"
        ? `[Guardian withheld the user's message before it reached you. ${verdict.reason}] Tell the user their message was withheld and why.`
        : verdict.text ?? event.text;
      return { action: "transform" as const, text };
    });
  };
  return { name: "joint-bob-guardian", factory, hidden: true };
}
