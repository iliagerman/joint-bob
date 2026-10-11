// Delivers a webhook call: a new conversation in the target project, or one more message in
// the target conversation. Runs through this node's own chat socket, like a scheduled task.
import { randomUUID } from "node:crypto";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { getConversationOwnership } from "../conversation-ownership.js";
import { ensureConversationRecord } from "../conversation-records.js";
import { listDiscoveredHarnesses } from "../harnesses/registry.js";
import { ensureSessionTitle } from "../names.js";
import { getProjectLock } from "../project-locks.js";
import { getProject } from "../store.js";
import { isHarnessId } from "../types.js";
import { recordWebhookDelivery, WebhookError, webhookMessage, type Webhook, type WebhookCall } from "../webhooks.js";
import { queueConversationPrompt } from "./conversation-prompt.js";
import { broadcastToProject } from "./realtime.js";

/** Calls accepted but not yet queued in a conversation. A flood waits here, not in sockets. */
const MAX_IN_FLIGHT = 20;
let inFlight = 0;

/** The harness a new conversation uses when the webhook names none: the first one this node can run. */
function defaultEngine(): string {
  const adapter = listDiscoveredHarnesses().find((candidate) => candidate.runtime);
  if (!adapter) throw new WebhookError(503, "No harness is available on this machine");
  return adapter.id;
}

/** Checks the target and queues the message. Throws when the target cannot take it. */
async function deliver(webhook: Webhook, call: WebhookCall): Promise<string> {
  const local = await getClusterNode();
  const project = await getProject(webhook.target.projectId);
  if (!project) throw new WebhookError(404, "The webhook's project no longer exists");
  const lock = await getProjectLock(project.id);
  if (lock && lock.nodeId !== local.id) throw new WebhookError(409, `Project is locked by ${lock.nodeName}`);
  const message = webhookMessage(webhook, call);
  const requestId = randomUUID();
  if (webhook.target.kind === "conversation") {
    const { sessionId, engine } = webhook.target;
    if (!isHarnessId(engine)) throw new WebhookError(409, "The conversation's agent is not available");
    const ownership = await getConversationOwnership(engine, sessionId);
    if (ownership && ownership.ownerNodeId !== local.id) throw new WebhookError(409, "The conversation lives on another machine; create the webhook there");
    await queueConversationPrompt({ projectId: project.id, engine, sessionId, message, requestId, label: "Webhook", until: "started" });
    return sessionId;
  }
  const engine = webhook.target.engine ?? defaultEngine();
  if (!isHarnessId(engine) || !listDiscoveredHarnesses().some((adapter) => adapter.id === engine && adapter.runtime)) throw new WebhookError(409, "The webhook's agent is not available on this machine");
  const sessionId = randomUUID();
  await ensureConversationRecord(project.id, engine, sessionId, local.id);
  await ensureSessionTitle(sessionId, webhook.name);
  broadcastToProject(project.id, { type: "sessionsChanged" });
  await queueConversationPrompt({ projectId: project.id, engine, sessionId, message, requestId, label: "Webhook", until: "started" });
  return sessionId;
}

/** Accepts a call for delivery. Returns false when too many deliveries are already waiting. */
export function acceptWebhookCall(webhook: Webhook, call: WebhookCall): boolean {
  if (inFlight >= MAX_IN_FLIGHT) return false;
  inFlight += 1;
  void (async () => {
    try {
      const sessionId = await deliver(webhook, call);
      recordWebhookDelivery(await clusterV2Database(), webhook.id, "delivered", webhook.target.kind === "project" ? `Started conversation ${sessionId}` : "Added to the conversation");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`Webhook ${webhook.id} delivery failed: ${detail}`);
      try { recordWebhookDelivery(await clusterV2Database(), webhook.id, "failed", detail); } catch { /* history is best effort */ }
    } finally {
      inFlight -= 1;
    }
  })();
  return true;
}
