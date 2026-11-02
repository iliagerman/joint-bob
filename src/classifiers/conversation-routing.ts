import { getGuardianSettings } from "../guardian/settings.js";
import { localLayaUrl } from "../guardian/laya.js";
import { classifyConversationChoiceWithSystemOne, type SystemOneTarget } from "./typesafe.js";

export interface AssistantRouteCandidate { id: string; title: string; summary: string }
export type AssistantRoute = { kind: "continue"; topicId: string } | { kind: "new" } | { kind: "recall" };

const TYPESAFE: SystemOneTarget = {
  endpoint: process.env.JOINT_BOB_TYPESAFE_ENDPOINT || "https://api.typesafe.ai/v1/systemone",
  model: "jev-latest",
  stateCharacters: 120_000,
  timeoutMs: 10_000,
};

export async function routeAssistantMessage(input: {
  classifierId: "typesafe" | "laya";
  apiKey: string;
  message: string;
  recentMessages: string[];
  topics: AssistantRouteCandidate[];
  history?: AssistantRouteCandidate[];
}, fetchImpl: typeof fetch = fetch): Promise<AssistantRoute | null> {
  if (!input.message.trim()) return null;
  const target = input.classifierId === "typesafe" ? TYPESAFE : await layaTarget(input.apiKey);
  if (!target || input.classifierId === "typesafe" && !input.apiKey) return null;
  const criteria = Object.fromEntries(input.topics.slice(0, 40).map((topic, index) => [
    `topic_${index}`, `Resume saved conversation ${topic.id}, titled ${topic.title}. ${topic.summary}`,
  ]));
  criteria.new_topic = "Start a fresh saved conversation because the user introduces a distinct subject or task.";
  criteria.recall_history = "Search prior conversation history to answer what happened, was decided, or said, without replacing the active work topic.";
  const state = JSON.stringify({ user_message: input.message, recent_assistant_chat: input.recentMessages.slice(-6), saved_topics: input.topics.slice(0, 40).map(({ id, title, summary }) => ({ id, title, summary })), accessible_history: (input.history ?? []).slice(0, 12).map(({ id, title, summary }) => ({ id, title, summary })) });
  const answer = await classifyConversationChoiceWithSystemOne(target, state, "route", criteria, input.classifierId === "laya" && !getGuardianSettings().layaUrl ? "" : input.apiKey, fetchImpl);
  if (!answer) return null;
  const index = /^topic_(\d+)$/.exec(answer.choice);
  if (index) {
    const topic = input.topics[Number(index[1])];
    return topic ? { kind: "continue", topicId: topic.id } : null;
  }
  if (answer.choice === "new_topic") return { kind: "new" };
  if (answer.choice === "recall_history") return { kind: "recall" };
  return null;
}

/** Where a decision for this assistant goes, and the key it carries; null when it cannot be asked. */
export async function decisionModelTarget(classifierId: "typesafe" | "laya", apiKey: string): Promise<{ target: SystemOneTarget; apiKey: string } | null> {
  if (classifierId === "typesafe") return apiKey ? { target: TYPESAFE, apiKey } : null;
  const target = await layaTarget(apiKey);
  return target ? { target, apiKey: getGuardianSettings().layaUrl ? apiKey : "" } : null;
}

async function layaTarget(apiKey: string): Promise<SystemOneTarget | null> {
  const remote = getGuardianSettings().layaUrl;
  try {
    const base = remote || await localLayaUrl();
    return { endpoint: `${base.replace(/\/+$/, "")}/v1/systemone`, model: "multilingual", stateCharacters: 3_500, timeoutMs: remote ? 20_000 : 120_000 };
  } catch { return null; }
}
