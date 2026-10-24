import { createHash } from "node:crypto";
import { chatScopeKey, chatState, conversationChatMaterial, saveChatState, type ChatQuestion, type ChatScope } from "../conversation-chat.js";
import { CHAT_PROMPT_BYTES, CHAT_SUMMARY_INSTRUCTIONS, isChatContextLimit, prepareChatContext } from "../conversation-chat-context.js";
import { storedTranscriptSummary, storeTranscriptSummary } from "../transcript-summary-store.js";
import { getSettings } from "../settings.js";
import type { HarnessId, ProjectRecord } from "../types.js";
import { loadConversationMessages } from "./conversation-turns.js";
import { runGitReview, type RunGitReviewInput } from "./git-review-run.js";
import { announceToAllClients, broadcastToAllClients } from "./realtime.js";

const running = new Set<string>();
const preparing = new Set<string>();
export function chatPreparing(scope: ChatScope): boolean { return preparing.has(JSON.stringify(scope)); }
interface ChatStream { id: string; questionId: string; text: string; contextCompacted: boolean }
const streams = new Map<string, ChatStream>();

export function chatStream(scope: ChatScope): ChatStream | null {
  return streams.get(JSON.stringify(scope)) ?? null;
}

export function chatRunning(scope: ChatScope): boolean {
  return running.has(JSON.stringify(scope));
}

export function chatChanged(scope: ChatScope, accountId: string, error?: string): void {
  broadcastToAllClients({ type: "conversationChatChanged", projectId: scope.projectId, conversationId: scope.conversationId, ...(error ? { error } : {}) }, accountId);
}

async function answerQuestion(project: ProjectRecord, scope: ChatScope, payload: ChatQuestion, accountId: string, onText: (text: string, compacted: boolean) => void) {
  const { messages, lastHarness } = await loadConversationMessages(project, scope.conversationId, { contextOnly: true });
  const state = chatState(scope);
  const attribution = [...messages].reverse().find((message) => message.role === "assistant" && message.attribution)?.attribution;
  const model = payload.model ?? {
    harnessId: attribution?.harnessId ?? lastHarness, provider: attribution?.provider ?? "", modelId: attribution?.modelId ?? "",
  };
  const history = state.messages.filter((message) => message.id !== payload.id);
  const material = conversationChatMaterial(messages, history);
  const run: RunGitReviewInput = {
    projectId: project.id, cwd: getSettings().projects.homePath, harnessId: model.harnessId as HarnessId,
    provider: model.provider, modelId: model.modelId, thinkingLevel: "",
    selection: { scope: "context", label: "conversation" }, question: "", diff: "", useTools: false,
  };
  const result = await answerWithContext(run, scope, accountId, material, payload.question, messages.some((message) => message.role === "summary"), onText);
  return { ...result, model: { harnessId: model.harnessId, provider: result.provider, modelId: result.modelId } };
}

async function answerWithContext(run: RunGitReviewInput, scope: ChatScope, accountId: string, material: string, question: string, nativeCompacted: boolean, onText: (text: string, compacted: boolean) => void) {
  const key = JSON.stringify(scope);
  const cacheKey = chatScopeKey(scope);
  const summaries = storedTranscriptSummary<Record<string, string>>("side-chat-context", cacheKey) ?? {};
  const summarize = async (chunk: string): Promise<string> => {
    preparing.add(key);
    chatChanged(scope, accountId);
    const hash = createHash("sha256").update(JSON.stringify([scope, run.harnessId, run.provider, run.modelId, CHAT_SUMMARY_INSTRUCTIONS, chunk])).digest("hex");
    if (summaries[hash] !== undefined) return summaries[hash];
    const summary = await runGitReview({ ...run, instructions: `${CHAT_SUMMARY_INSTRUCTIONS}\n\n${chunk}` });
    summaries[hash] = summary.answer;
    storeTranscriptSummary("side-chat-context", cacheKey, summaries);
    return summary.answer;
  };
  for (const limit of [CHAT_PROMPT_BYTES, CHAT_PROMPT_BYTES / 2, CHAT_PROMPT_BYTES / 4]) {
    let streamed = false;
    try {
      const context = await prepareChatContext(material, question, summarize, limit);
      preparing.delete(key);
      chatChanged(scope, accountId);
      const contextCompacted = nativeCompacted || context.compacted;
      const result = await runGitReview({ ...run, instructions: context.prompt, onText: (text) => { streamed = true; onText(text, contextCompacted); } });
      return { ...result, contextCompacted };
    } catch (error) {
      if (streamed || !isChatContextLimit(error) || limit === CHAT_PROMPT_BYTES / 4) throw error;
    }
  }
  throw new Error("Side-chat context preparation failed");
}

async function drainQueue(project: ProjectRecord, scope: ChatScope, accountId: string): Promise<void> {
  while (chatState(scope).queue.length) {
    const state = chatState(scope);
    const question = state.queue.shift()!;
    state.messages.push({ id: question.id, role: "user", text: question.question });
    saveChatState(scope, state);
    chatChanged(scope, accountId);
    let firstChunk = true;
    try {
      const result = await answerQuestion(project, scope, question, accountId, (text, contextCompacted) => {
        const stream = { id: `answer:${question.id}`, questionId: question.id, text, contextCompacted };
        streams.set(JSON.stringify(scope), stream);
        announceToAllClients({ type: "conversationChatStream", projectId: scope.projectId, conversationId: scope.conversationId, stream,
          ...(firstChunk ? { messages: state.messages } : {}),
        }, accountId);
        firstChunk = false;
      });
      // New questions may have arrived during the answer. Never save the old queue snapshot.
      const latest = chatState(scope);
      latest.messages.push({ id: `answer:${question.id}`, role: "assistant", text: result.answer, ...(result.contextCompacted ? { contextCompacted: true } : {}) });
      latest.model = result.model;
      saveChatState(scope, latest);
    } catch (error) {
      const latest = chatState(scope);
      latest.messages.at(-1)!.error = error instanceof Error ? error.message : "Side-chat answer failed";
      saveChatState(scope, latest);
    }
    preparing.delete(JSON.stringify(scope));
    streams.delete(JSON.stringify(scope));
    chatChanged(scope, accountId);
  }
}

/** One worker per user's side chat. Stored waiting questions also resume when Chat is reopened. */
export function startChatQueue(project: ProjectRecord, scope: ChatScope, accountId: string): void {
  if (chatRunning(scope) || !chatState(scope).queue.length) return;
  const key = JSON.stringify(scope);
  running.add(key);
  void drainQueue(project, scope, accountId).then(() => {
    running.delete(key);
    startChatQueue(project, scope, accountId);
    chatChanged(scope, accountId);
  }).catch((error) => {
    running.delete(key);
    console.error("Side-chat queue failed", error);
    chatChanged(scope, accountId, error instanceof Error ? error.message : "Side-chat queue failed");
  });
}
