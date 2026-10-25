import { getHarnessRuntime } from "../harnesses.js";
import { internalSessionId } from "../internal-sessions.js";
import { conversationScopeId, setScopeSecretAccounts } from "../secrets.js";
import { chatModelSchema, type ChatAgent, type ChatModel } from "../conversation-chat.js";
import type { HarnessModelSettings } from "../harnesses/runtime.js";

/** Only built-in readers. Unknown extensions, shell, web and delegated agents are never read-only tools. */
export function readOnlyChatTools(harnessId: string): string[] {
  switch (harnessId) {
    case "pi": return ["read", "grep", "find", "ls"];
    case "claude": return ["Read", "Grep", "Glob"];
    case "kiro": return ["read"];
    default: return [];
  }
}

interface ChatAgentInput {
  projectId: string;
  conversationId: string;
  cwd: string;
  model: ChatModel;
  readOnly: boolean;
  agent?: ChatAgent;
  accountIds: string[];
  prompt: string;
  onText: (text: string) => void;
  onAgent: (agent: ChatAgent) => void;
  beforeStart: () => Promise<void>;
}

/** Resume only the private side agent, never the source conversation's runtime. */
export async function runChatAgent(input: ChatAgentInput) {
  const runtime = await getHarnessRuntime(input.model.harnessId);
  const previous = input.agent?.harnessId === input.model.harnessId && input.agent.cwd === input.cwd ? input.agent : undefined;
  const sessionId = previous?.sessionId ?? internalSessionId();
  await setScopeSecretAccounts("conversation", conversationScopeId(input.model.harnessId, sessionId), input.readOnly ? [] : input.accountIds);
  const session = await runtime.open({ projectId: input.projectId, conversationId: input.conversationId,
    cwd: input.cwd, sessionId, sessionPath: previous?.sessionPath, accountIds: input.readOnly ? [] : input.accountIds });
  let text = "";
  const actionTools = input.model.harnessId === "pi"
    ? previous?.actionTools ?? session.tools().filter(tool => tool.active).map(tool => tool.name)
    : undefined;
  const saveAgent = () => {
    if (session.file) input.onAgent({ harnessId: input.model.harnessId, sessionId, sessionPath: session.file, cwd: input.cwd, ...(actionTools ? { actionTools } : {}) });
  };
  const unsubscribe = session.subscribe(event => {
    if (event.type === "textDelta" && typeof event.text === "string") { text += event.text; input.onText(text); }
    if (event.type === "sessionFile") saveAgent();
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const base = session.settings();
    const enabledTools = input.readOnly ? readOnlyChatTools(input.model.harnessId) : actionTools;
    // Claude reports its tool catalogue only after a turn. Its configure boundary accepts built-in names before then.
    const available = session.tools();
    const settings: HarnessModelSettings = {
      provider: input.model.provider || base.provider, modelId: input.model.modelId || base.modelId,
      reasoning: input.model.thinkingLevel || base.reasoning,
      enabledTools: enabledTools && (available.length ? enabledTools.filter(name => available.some(tool => tool.name === name)) : enabledTools),
    };
    await runtime.validateSettings(settings);
    await session.configure(settings);
    await session.preflight();
    await input.beforeStart();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void session.cancel("Activity Chat timed out").catch(error => console.error("Could not cancel timed-out Activity Chat", error));
        reject(new Error("Activity Chat timed out"));
      }, 5 * 60_000);
      timer.unref();
    });
    await Promise.race([session.prompt({ text: input.prompt, beforeStart: input.beforeStart }), timeout]);
    if (!text.trim()) throw new Error("Activity Chat produced no answer");
    saveAgent();
    const status = session.status();
    return { answer: text.trim(), model: chatModelSchema.parse({ harnessId: input.model.harnessId,
      provider: status.model?.provider ?? settings.provider, modelId: status.model?.id ?? settings.modelId,
      thinkingLevel: settings.reasoning }) };
  } finally {
    clearTimeout(timer);
    unsubscribe();
    try { if (session.isBusy()) await session.cancel(); }
    finally { session.dispose(); }
  }
}
