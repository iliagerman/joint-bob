import { internalSessionId } from "../internal-sessions.js";
import { getHarness, getHarnessRuntime } from "../harnesses.js";
import type { HarnessEvent, HarnessModelSettings } from "../harnesses/runtime.js";
import type { AutoRespondConfig } from "../conversation-auto-respond.js";

const RESPONDER_TIMEOUT_MS = 120_000;

export interface AutoRespondRunInput {
  projectId: string;
  conversationId: string;
  cwd: string;
  accountIds?: string[];
  config: AutoRespondConfig;
  prompt: string;
  signal: AbortSignal;
}

/**
 * One responder decision in a throwaway, tool-less harness session, disposed before
 * returning so it never joins the project's conversations. Opening through the guarded
 * runtime makes a used-up budget refuse the run.
 */
export async function runAutoResponder(input: AutoRespondRunInput): Promise<string> {
  const override = process.env.JOINT_BOB_AUTO_RESPONDER;
  if (override) {
    const module = await import(override) as { default: (input: AutoRespondRunInput) => Promise<string> };
    return module.default(input);
  }
  const adapter = getHarness(input.config.harnessId as never);
  if (!adapter.runtime) throw new Error(`${adapter.label} cannot run the auto responder`);
  const runtime = await getHarnessRuntime(input.config.harnessId as never);
  const session = await runtime.open({ projectId: input.projectId, cwd: input.cwd, sessionId: internalSessionId(), conversationId: input.conversationId, ...(input.accountIds ? { accountIds: input.accountIds } : {}) });
  const events: string[] = [];
  const unsubscribeText = session.subscribe((event: HarnessEvent) => {
    if (event.type === "agent_start") events.length = 0;
    if (event.type === "textDelta" && typeof event.text === "string") events.push(event.text);
  });
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const base = session.settings();
    const settings: HarnessModelSettings = { ...base, provider: input.config.provider, modelId: input.config.modelId, reasoning: input.config.thinkingLevel };
    await runtime.validateSettings(settings);
    await session.configure(settings);
    await session.preflight();
    // The responder only judges and writes text; a harness that cannot turn its tools off cannot be one.
    await session.setTools([]);
    const done = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => { void session.cancel().catch(() => {}); reject(new Error("The auto responder timed out")); }, RESPONDER_TIMEOUT_MS);
      timer.unref();
      onAbort = () => { void session.cancel().catch(() => {}); reject(new Error("Auto respond was cancelled")); };
      if (input.signal.aborted) onAbort(); else input.signal.addEventListener("abort", onAbort, { once: true });
      const stop = session.subscribe((event: HarnessEvent) => {
        if (event.type === "agent_end") { stop(); resolve(); }
        if (event.type === "error") { stop(); reject(new Error(typeof event.error === "string" ? event.error : "The auto responder failed")); }
      });
    });
    await session.prompt({ text: input.prompt });
    await done;
    return events.join("").trim();
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) input.signal.removeEventListener("abort", onAbort);
    unsubscribeText();
    try { if (session.isBusy()) await session.cancel(); } catch { /* torn down regardless */ }
    session.dispose();
  }
}
