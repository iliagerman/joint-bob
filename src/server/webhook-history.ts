import { clusterV2Database } from "../cluster-v2-store.js";
import { getClusterNode } from "../cluster.js";
import { setWebhookConversationHistory } from "../conversation-records.js";
import { ensureWebhookAgentSchema } from "../webhook-agent.js";
import { getWebhook, WebhookError, type Webhook } from "../webhooks.js";
import { broadcastToProject } from "./realtime.js";

/** Saved bindings cover old runs too, without guessing from their titles. */
export async function updateWebhookHistory(webhook: Webhook): Promise<void> {
  const db = await clusterV2Database();
  ensureWebhookAgentSchema(db);
  const owner = await getClusterNode();
  const current = getWebhook(db, webhook.id);
  if (!current) throw new WebhookError(404, "Webhook not found");
  const bindings = db.prepare("SELECT project_id,conversation_id FROM webhook_conversation_bindings WHERE webhook_id=? AND created_conversation=1")
    .all(webhook.id) as Array<{ project_id: string; conversation_id: string }>;
  for (const binding of bindings) {
    setWebhookConversationHistory(db, binding.project_id, binding.conversation_id, webhook.id, current.hideFromHistory, owner.id);
  }
  for (const projectId of new Set(bindings.map(binding => binding.project_id))) broadcastToProject(projectId, { type: "sessionsChanged" });
}
