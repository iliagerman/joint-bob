import { spawn } from "node:child_process";
import { getHarnessRuntime } from "../harnesses.js";
import { internalSessionId } from "../internal-sessions.js";
import type { HarnessId } from "../types.js";
import { removeSecrets, removeSecretsFromValue } from "./redact.js";
import type { GuardianFix, GuardianRequest } from "./rules.js";

/** Helper agents that fix content are not checked themselves; what they return is checked again. */
const exemptConversations = new Set<string>();
export const isGuardianExempt = (projectId: string, conversationId: string) => exemptConversations.has(`${projectId}:${conversationId}`);
function exemptFromGuardian(projectId: string, conversationId: string): () => void {
  const key = `${projectId}:${conversationId}`;
  exemptConversations.add(key);
  return () => exemptConversations.delete(key);
}

const FIX_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 2_000_000;

interface FixContext { projectId: string; harness: HarnessId; cwd: string; secrets: string[] }

/** The text a script or helper agent rewrites: the content, or the tool call's arguments as JSON. */
const material = (request: GuardianRequest) => request.kind === "outgoing" ? request.text : JSON.stringify(request.input, null, 2);

function fromMaterial(request: GuardianRequest, text: string): GuardianRequest {
  if (request.kind === "outgoing") return { ...request, text };
  const input = JSON.parse(text) as unknown;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A fix for a tool call must print a JSON object");
  return { ...request, input: input as Record<string, unknown> };
}

function runScript(command: string, input: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("The Guardian fix script timed out")); }, FIX_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk; if (output.length > OUTPUT_LIMIT) child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk: Buffer) => { errors = `${errors}${chunk}`.slice(-1_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.replace(/\n$/, ""));
      else reject(new Error(`The Guardian fix script stopped with code ${code}. ${errors.trim()}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** A one-turn session of the conversation's own agent, with every tool turned off. */
async function runHelperAgent(instructions: string, input: string, context: FixContext): Promise<string> {
  const runtime = await getHarnessRuntime(context.harness);
  const sessionId = internalSessionId();
  const release = exemptFromGuardian(context.projectId, sessionId);
  const session = await runtime.open({ projectId: context.projectId, cwd: context.cwd, sessionId });
  let text = "";
  const unsubscribe = session.subscribe((event) => { if (event.type === "textDelta" && typeof event.text === "string") text += event.text; });
  try {
    await session.setTools([]);
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { void session.cancel().catch(() => {}); reject(new Error("The Guardian helper agent timed out")); }, FIX_TIMEOUT_MS);
      session.subscribe((event) => {
        if (event.type === "agent_end") { clearTimeout(timer); resolve(); }
        if (event.type === "error") { clearTimeout(timer); reject(new Error(typeof event.error === "string" ? event.error : "The Guardian helper agent failed")); }
      });
    });
    done.catch(() => undefined);
    await session.prompt({ text: `${instructions}\n\nReply with the rewritten content only, nothing before or after it. Keep its format${input.trimStart().startsWith("{") ? " (a JSON object)" : ""}.\n\n<content>\n${input}\n</content>` });
    await done;
    const reply = text.trim().replace(/^```[a-z]*\n([\s\S]*)\n```$/, "$1");
    if (!reply) throw new Error("The Guardian helper agent returned nothing");
    return reply;
  } finally {
    unsubscribe();
    if (session.isBusy()) await session.cancel().catch(() => {});
    session.dispose();
    release();
  }
}

/** The request with one rule's fix applied. The result is checked again before anything goes ahead. */
export async function runGuardianFix(fix: GuardianFix, request: GuardianRequest, context: FixContext): Promise<GuardianRequest> {
  if (fix.kind === "remove-secrets") {
    return request.kind === "outgoing"
      ? { ...request, text: removeSecrets(request.text, context.secrets) }
      : { ...request, input: removeSecretsFromValue(request.input, context.secrets) as Record<string, unknown> };
  }
  const input = material(request);
  const output = fix.kind === "script" ? await runScript(fix.command, input, context.cwd) : await runHelperAgent(fix.instructions, input, context);
  return fromMaterial(request, output);
}
