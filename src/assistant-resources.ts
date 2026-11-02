import type { DatabaseSync } from "node:sqlite";
import { settingsDatabase } from "./settings-store.js";

// Synchronous reads used while an agent's resources are assembled. They import nothing
// heavier than the settings connection, so skill and plugin loading can call them.

export interface AssistantDisabledResources { skills: string[]; plugins: string[] }

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/** The assistant whose topic this conversation is, or null for an ordinary conversation. */
export function assistantIdForConversation(projectId: string | undefined, conversationId: string | undefined): string | null {
  if (!projectId || !conversationId) return null;
  const db = settingsDatabase();
  if (!hasTable(db, "personal_assistant_topics")) return null;
  const row = db.prepare("SELECT assistant_id id FROM personal_assistant_topics WHERE project_id=? AND session_id=? ORDER BY topic_index LIMIT 1").get(projectId, conversationId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Skills and plugins the owning assistant turned off for this topic conversation. */
export function assistantDisabledResources(projectId: string | undefined, conversationId: string | undefined): AssistantDisabledResources {
  const assistantId = assistantIdForConversation(projectId, conversationId);
  if (!assistantId) return { skills: [], plugins: [] };
  const db = settingsDatabase();
  if (!hasTable(db, "personal_assistant_resources")) return { skills: [], plugins: [] };
  const row = db.prepare("SELECT disabled_skills skills, disabled_plugins plugins FROM personal_assistant_resources WHERE assistant_id=?").get(assistantId) as { skills: string; plugins: string } | undefined;
  return row ? { skills: JSON.parse(row.skills) as string[], plugins: JSON.parse(row.plugins) as string[] } : { skills: [], plugins: [] };
}

/** True when both conversations are topics of one assistant, so they take turns with its logins. */
export function sameAssistantTopics(projectId: string, first: string, second: string): boolean {
  const assistant = assistantIdForConversation(projectId, first);
  return assistant !== null && assistant === assistantIdForConversation(projectId, second);
}
