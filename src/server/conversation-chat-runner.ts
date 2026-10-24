import { chatState, conversationChatPrompt, saveChatState, type ChatQuestion, type ChatScope } from "../conversation-chat.js";
import { getSettings } from "../settings.js";
import type { HarnessId, ProjectRecord } from "../types.js";
import { loadConversationMessages } from "./conversation-turns.js";
import { runGitReview } from "./git-review-run.js";
import { announceToAllClients, broadcastToAllClients } from "./realtime.js";

const running = new Set<string>();
interface ChatStream { id: string; questionId: string; text: string }
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

async function answerQuestion(project: ProjectRecord, scope: ChatScope, payload: ChatQuestion, onText: (text: string) => void) {
  const { messages, lastHarness } = await loadConversationMessages(project, scope.conversationId);
  const state = chatState(scope);
  const attribution = [...messages].reverse().find((message) => message.role === "assistant" && message.attribution)?.attribution;
  const model = payload.model ?? {
    harnessId: attribution?.harnessId ?? lastHarness, provider: attribution?.provider ?? "", modelId: attribution?.modelId ?? "",
  };
  const history = state.messages.filter((message) => message.id !== payload.id);
  const instructions = conversationChatPrompt(messages, history, payload.question);
  const result = await runGitReview({
    projectId: project.id, cwd: getSettings().projects.homePath, harnessId: model.harnessId as HarnessId,
    provider: model.provider, modelId: model.modelId, thinkingLevel: "",
    selection: { scope: "context", label: "conversation" }, question: "", diff: "", instructions,
    useTools: false, onText,
  });
  return { answer: result.answer, model: { harnessId: model.harnessId, provider: result.provider, modelId: result.modelId } };
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
      const result = await answerQuestion(project, scope, question, (text) => {
        const stream = { id: `answer:${question.id}`, questionId: question.id, text };
        streams.set(JSON.stringify(scope), stream);
        announceToAllClients({ type: "conversationChatStream", projectId: scope.projectId, conversationId: scope.conversationId, stream,
          ...(firstChunk ? { messages: state.messages } : {}),
        }, accountId);
        firstChunk = false;
      });
      // New questions may have arrived during the answer. Never save the old queue snapshot.
      const latest = chatState(scope);
      latest.messages.push({ id: `answer:${question.id}`, role: "assistant", text: result.answer });
      latest.model = result.model;
      saveChatState(scope, latest);
    } catch (error) {
      const latest = chatState(scope);
      latest.messages.at(-1)!.error = error instanceof Error ? error.message : "Side-chat answer failed";
      saveChatState(scope, latest);
    }
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
