import { internalSessionId } from "../internal-sessions.js";
import { getHarness, getHarnessRuntime } from "../harnesses.js";
import type { HarnessEvent, HarnessModelSettings } from "../harnesses/runtime.js";
import type { DashboardAgentSettings } from "../settings.js";
import { toolTarget } from "../tool-target.js";

/** One tool the agent started, with what it acted on (a file, a command) when the harness says. */
export interface DashboardAgentActivity { tool: string; target?: string }

export interface DashboardAgentTurnInput {
  /** The dashboard's host project: its secrets and budget apply to the turn. */
  projectId: string;
  cwd: string;
  conversationId?: string;
  accountIds?: string[];
  settings: DashboardAgentSettings;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Each tool the agent starts, so the view can show what it is doing. */
  onActivity?: (activity: DashboardAgentActivity) => void;
  /** The agent's answer so far, as it writes it. */
  onText?: (soFar: string) => void;
}

/**
 * One turn of the dashboard agent in a throwaway, hidden harness session, disposed before
 * returning so it never joins the project's conversations. Opening through the guarded
 * runtime makes a used-up budget refuse the turn. Returns the agent's final text.
 */
export async function runDashboardAgentTurn(input: DashboardAgentTurnInput): Promise<string> {
  const override = process.env.JOINT_BOB_DASHBOARD_AGENT;
  if (override) {
    const module = await import(override) as { default: (input: DashboardAgentTurnInput) => Promise<string> };
    return module.default(input);
  }
  const adapter = getHarness(input.settings.harnessId as never);
  if (!adapter.runtime) throw new Error(`${adapter.label} cannot run the dashboard agent`);
  const runtime = await getHarnessRuntime(input.settings.harnessId as never);
  const session = await runtime.open({ projectId: input.projectId, cwd: input.cwd, sessionId: internalSessionId(),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}), ...(input.accountIds ? { accountIds: input.accountIds } : {}) });
  let text = "";
  const unsubscribe = session.subscribe((event: HarnessEvent) => {
    if (event.type === "agent_start") text = "";
    if (event.type === "textDelta" && typeof event.text === "string") { text += event.text; input.onText?.(text); }
    if (event.type === "toolStart") {
      const found = toolTarget(String(event.toolName), event.args);
      const target = found?.target ?? found?.skill;
      input.onActivity?.({ tool: String(event.toolName), ...(target ? { target } : {}) });
    }
  });
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const base = session.settings();
    const settings: HarnessModelSettings = { ...base, provider: input.settings.provider, modelId: input.settings.modelId, reasoning: input.settings.thinkingLevel };
    await runtime.validateSettings(settings);
    await session.configure(settings);
    await session.preflight();
    const done = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => { void session.cancel().catch(() => {}); reject(new Error("The dashboard agent timed out")); }, input.timeoutMs);
      timer.unref();
      onAbort = () => { void session.cancel().catch(() => {}); reject(new Error("The dashboard agent was stopped")); };
      if (input.signal?.aborted) onAbort(); else input.signal?.addEventListener("abort", onAbort, { once: true });
      const stop = session.subscribe((event: HarnessEvent) => {
        if (event.type === "agent_end") { stop(); resolve(); }
        if (event.type === "error") { stop(); reject(new Error(typeof event.error === "string" ? event.error : "The dashboard agent failed")); }
      });
    });
    // A prompt that fails before the turn ends leaves `done` unawaited; its later outcome is moot.
    done.catch(() => undefined);
    await session.prompt({ text: input.prompt });
    await done;
    return text.trim();
  } finally {
    clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    try { if (session.isBusy()) await session.cancel(); } catch { /* the session is being disposed regardless */ }
    session.dispose();
  }
}
