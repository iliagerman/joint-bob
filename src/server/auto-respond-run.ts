import { internalSessionId } from "../internal-sessions.js";
import { getHarness, getHarnessRuntime } from "../harnesses.js";
import type { HarnessEvent, HarnessModelSettings } from "../harnesses/runtime.js";
import type { AutoRespondConfig } from "../conversation-auto-respond.js";

// Checking the agent's work can mean running a test suite; judging text alone is quick.
const RESPONDER_TIMEOUT_MS = 20 * 60_000;
const TEXT_ONLY_TIMEOUT_MS = 120_000;

export interface AutoRespondRunInput {
  projectId: string;
  conversationId: string;
  cwd: string;
  accountIds?: string[];
  config: AutoRespondConfig;
  prompt: string;
  signal: AbortSignal;
  /** Names each tool the responder starts, so the conversation can show what it is checking. */
  onStep: (step: string) => void;
}

/**
 * One responder decision in a throwaway harness session in the project folder, disposed before
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
    if (event.type === "toolStart") input.onStep(String(event.toolName));
  });
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const base = session.settings();
    const settings: HarnessModelSettings = { ...base, provider: input.config.provider, modelId: input.config.modelId, reasoning: input.config.thinkingLevel };
    await runtime.validateSettings(settings);
    await session.configure(settings);
    await session.preflight();
    // With tools off the responder only judges text; a harness that cannot turn its tools off cannot run that way.
    if (!input.config.useTools) await session.setTools([]);
    const done = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => { void session.cancel().catch(() => {}); reject(new Error("The auto responder timed out")); }, input.config.useTools ? RESPONDER_TIMEOUT_MS : TEXT_ONLY_TIMEOUT_MS);
      timer.unref();
      onAbort = () => { void session.cancel().catch(() => {}); reject(new Error("Auto respond was cancelled")); };
      if (input.signal.aborted) onAbort(); else input.signal.addEventListener("abort", onAbort, { once: true });
      const stop = session.subscribe((event: HarnessEvent) => {
        if (event.type === "agent_end") { stop(); resolve(); }
        if (event.type === "error") { stop(); reject(new Error(typeof event.error === "string" ? event.error : "The auto responder failed")); }
      });
    });
    // A prompt that fails first leaves `done` unawaited; its later outcome is moot.
    done.catch(() => undefined);
    // A harness cannot cancel a turn it has not started, so a cancel that lands while the
    // responder is still opening must keep the turn from starting at all.
    const cancelled = () => { if (input.signal.aborted) throw new Error("Auto respond was cancelled"); };
    cancelled();
    await session.prompt({ text: input.prompt, beforeStart: async () => cancelled() });
    await done;
    // After tool calls the reply spans several messages; the decision is in the last one.
    const last = [...session.messages].reverse().find((message) => message.role === "assistant" && message.text.trim());
    return (last?.text ?? events.join("")).trim();
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) input.signal.removeEventListener("abort", onAbort);
    unsubscribeText();
    try { if (session.isBusy()) await session.cancel(); } catch { /* torn down regardless */ }
    session.dispose();
  }
}
