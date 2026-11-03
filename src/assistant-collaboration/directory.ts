import type { DatabaseSync } from "node:sqlite";
import { getClusterNode } from "../cluster.js";
import { isTrustedTwin } from "../cluster-sharing-policy.js";
import { browserRuntime } from "../server/browser.js";
import { assistantLoginProfileIds, listPersonalAssistants, personalAssistantDatabase, type PersonalAssistant } from "../personal-assistants.js";
import { conversationScopeId, getScopeSecretAccounts, listSecretAccounts } from "../secrets.js";
import { instructionsDigest, listActions } from "../social/actions.js";
import { projectPrivateToOwner } from "../store.js";
import { askAllowedBySwitch } from "./store.js";

/** What other assistants of the same owner may know about an assistant. Skills and plugins are left out: they are machine-wide. */
export interface AssistantSummary {
  id: string; accountId: string; name: string; nodeId: string; machineName: string;
  about: string; has: string[]; private: boolean; instructions: string;
  actions: Array<{ id: string; name: string; description: string; instructions: string; operations: string[]; revision: number; digest: string; status: "published" }>;
}
export interface HelperView extends AssistantSummary { enabled: boolean; available: boolean; reason: string | null }

async function database(): Promise<DatabaseSync> {
  const db = await personalAssistantDatabase();
  db.exec("CREATE TABLE IF NOT EXISTS assistant_twin_summaries (node_id TEXT NOT NULL, assistant_id TEXT NOT NULL, summary TEXT NOT NULL, PRIMARY KEY(node_id, assistant_id))");
  return db;
}

async function attachedLabels(assistant: PersonalAssistant): Promise<string[]> {
  const { accountIds } = await getScopeSecretAccounts("conversation", conversationScopeId(assistant.engine, assistant.sessionId));
  const secrets = (await listSecretAccounts()).filter(account => accountIds.includes(account.id)).map(account => account.label);
  const logins = (await assistantLoginProfileIds(assistant.id)).flatMap(id => browserRuntime().profileOrNull(id)?.label ?? []);
  return [...secrets, ...logins, ...assistant.mcpServerNames ?? []];
}

async function summarize(assistant: PersonalAssistant, local: { id: string; name: string }): Promise<AssistantSummary> {
  const actions = (await listActions(assistant.id)).filter(action => action.status === "published").map(action => ({
    id: action.id, name: action.name, description: action.description, instructions: action.instructions, operations: action.operations as string[],
    revision: action.revision, digest: instructionsDigest(assistant.instructions, action), status: "published" as const,
  }));
  // The machine stored as its execution machine; only this one's name is known here.
  const elsewhere = Boolean(assistant.nodeId) && assistant.nodeId !== local.id;
  return {
    id: assistant.id, accountId: assistant.accountId, name: assistant.name, nodeId: assistant.nodeId || local.id, machineName: elsewhere ? "another machine" : local.name,
    about: assistant.instructions.slice(0, 300), has: [...await attachedLabels(assistant), ...actions.map(action => action.name)],
    private: await projectPrivateToOwner(assistant.projectId), instructions: assistant.instructions, actions,
  };
}

export async function localAssistantSummaries(accountId: string): Promise<AssistantSummary[]> {
  const local = await getClusterNode();
  return Promise.all((await listPersonalAssistants(accountId)).map(assistant => summarize(assistant, local)));
}

/** What a twin said about its assistants, replacing everything it said before. */
export async function replaceTwinSummaries(nodeId: string, summaries: AssistantSummary[]): Promise<void> {
  const db = await database();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM assistant_twin_summaries WHERE node_id=?").run(nodeId);
    for (const summary of summaries) db.prepare("INSERT INTO assistant_twin_summaries (node_id, assistant_id, summary) VALUES (?,?,?)").run(nodeId, summary.id, JSON.stringify(summary));
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** This machine's assistants of the owner, then the twins' as last reported. The local copy wins. */
export async function ownerAssistants(accountId: string): Promise<AssistantSummary[]> {
  const db = await database(), local = (await getClusterNode()).id;
  const cached = (db.prepare("SELECT node_id nodeId, summary FROM assistant_twin_summaries").all() as Array<{ nodeId: string; summary: string }>)
    .filter(row => isTrustedTwin(db, local, row.nodeId)).map(row => JSON.parse(row.summary) as AssistantSummary).filter(summary => summary.accountId === accountId);
  return [...new Map([...cached, ...await localAssistantSummaries(accountId)].map(summary => [summary.id, summary])).values()];
}

export function sharedAskerReason(asker: { name: string }): string { return `${asker.name} is in a shared project, so it can't ask your other assistants.`; }
export function sharedHelperReason(helper: { name: string }): string { return `${helper.name} is in a shared project, so other assistants can't ask it.`; }
function unavailableReason(asker: PersonalAssistant, helper: AssistantSummary, enabled: boolean, askerPrivate: boolean): string | null {
  if (!enabled) return "Turned off for this assistant.";
  if (!askerPrivate) return sharedAskerReason(asker);
  if (!helper.private) return sharedHelperReason(helper);
  return null;
}

/** Every other assistant of the owner, with whether the asker may ask it now and why not. */
export async function askableHelpers(asker: PersonalAssistant): Promise<HelperView[]> {
  const askerPrivate = await projectPrivateToOwner(asker.projectId);
  const helpers = (await ownerAssistants(asker.accountId)).filter(summary => summary.id !== asker.id);
  return Promise.all(helpers.map(async helper => {
    const enabled = await askAllowedBySwitch(asker.id, helper.id);
    const reason = unavailableReason(asker, helper, enabled, askerPrivate);
    return { ...helper, enabled, available: reason === null, reason };
  }));
}
