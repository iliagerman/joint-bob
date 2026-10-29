// Delivers a webhook call: a new conversation in the target project, or one more message in
// the target conversation. Runs through this node's own chat socket, like a scheduled task.
import { randomUUID } from "node:crypto";
import { automationProfileContext, runWithAutomationProfile } from "./automation-profile.js";
import { createAutomationExecution, transitionAutomationExecution } from "../automation-executions.js";
import { automationWorkspaceIdentity, automationWorkspaceKey, snapshotAutomationTags } from "../automation-tags.js";
import path from "node:path";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { getConversationOwnership } from "../conversation-ownership.js";
import { ensureConversationRecord } from "../conversation-records.js";
import { listDiscoveredHarnesses } from "../harnesses/registry.js";
import { ensureSessionTitle } from "../names.js";
import { bindWebhookTitle, titlePlaceholders } from "../webhook-title.js";
import { getProjectLock } from "../project-locks.js";
import { getProject } from "../store.js";
import { conversationScopeId, getScopeSecretAccounts, setScopeSecretAccounts, validateProjectSecretAccounts } from "../secrets.js";
import { recordTurnFailure } from "../turn-failures.js";
import { isHarnessId } from "../types.js";
import {
  MAX_PAYLOAD_CHARS, PAYLOAD_FILE_NAME, recordWebhookDelivery, WebhookError, webhookMessage, type Webhook, type WebhookAttachment, type WebhookCall,
} from "../webhooks.js";
import { persistTaskAttachments } from "./chat.js";
import { markSilentWebhookRequest } from "./scheduled-review.js";
import { snapshotWebhookResources, resolveWebhookResources, webhookResourceInstructions } from "../webhook-resources.js";
import { bindWebhookConversation } from "../webhook-agent.js";
import { readWebhookMemory } from "../webhook-memory.js";
import { queueConversationPrompt, type PromptAttachment, type PromptQueueSettings } from "./conversation-prompt.js";
import { broadcastToProject } from "./realtime.js";

/** What one chat-socket prompt may carry, as for a browser message (src/server/schemas.ts). */
const SOCKET_IMAGES = 4;
const SOCKET_FILES = 6;
const SOCKET_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/** The harness a new conversation uses when the webhook names none: the first one this node can run. */
function defaultEngine(): string {
  const adapter = listDiscoveredHarnesses().find((candidate) => candidate.runtime);
  if (!adapter) throw new WebhookError(503, "No harness is available on this machine");
  return adapter.id;
}

/**
 * Splits a call's files between the prompt and the disk. Images and files that fit a chat
 * message travel with it, so the agent sees images as images and the transcript shows them.
 * The rest are saved to the project's attachments folder and listed by path in the message.
 */
async function placeAttachments(cwd: string, attachments: WebhookAttachment[]) {
  const images: PromptAttachment[] = [];
  const files: PromptAttachment[] = [];
  const spill: { images: PromptAttachment[]; files: PromptAttachment[] } = { images: [], files: [] };
  for (const attachment of attachments) {
    const encoded = { name: attachment.name, mimeType: attachment.mimeType, data: attachment.data.toString("base64") };
    const image = attachment.mimeType.startsWith("image/");
    const fits = attachment.data.byteLength > 0 && attachment.data.byteLength <= SOCKET_ATTACHMENT_BYTES;
    if (image && fits && images.length < SOCKET_IMAGES) images.push(encoded);
    else if (!image && fits && files.length < SOCKET_FILES) files.push(encoded);
    else (image ? spill.images : spill.files).push(encoded);
  }
  const saved = await persistTaskAttachments(cwd, spill.images, spill.files);
  const listed = saved.length
    ? `More files from this call, saved in the project:\n${saved.map((file) => `- ${file.name}: ${path.resolve(cwd, file.path)}`).join("\n")}\nOpen them from these paths when needed.`
    : "";
  return { images, files, listed };
}

/** Explicit webhook accounts add to, never replace, a conversation's existing attachments. */
async function attachSecrets(webhook: Webhook, engine: string, sessionId: string): Promise<void> {
  if (!webhook.secretAccountIds.length) return;
  if (!isHarnessId(engine)) throw new WebhookError(409, "The webhook's harness is not available");
  validateProjectSecretAccounts(webhook.target.projectId, webhook.secretAccountIds);
  const scope = conversationScopeId(engine, sessionId);
  const { accountIds } = await getScopeSecretAccounts("conversation", scope);
  await setScopeSecretAccounts("conversation", scope, [...new Set([...accountIds, ...webhook.secretAccountIds])]);
}

/** Checks the target and queues the message. Throws when the target cannot take it. */
async function deliver(webhook: Webhook, call: WebhookCall): Promise<string> {
  return runWithAutomationProfile(webhook, () => deliverWithProfile(webhook, call));
}

async function deliverWithProfile(webhook: Webhook, call: WebhookCall): Promise<string> {
  const local = await getClusterNode();
  const project = await getProject(webhook.target.projectId);
  if (!project) throw new WebhookError(404, "The webhook's project no longer exists");
  const lock = await getProjectLock(project.id);
  if (lock && lock.nodeId !== local.id) throw new WebhookError(409, `Project is locked by ${lock.nodeName}`);
  const db = await clusterV2Database();
  const resourceSnapshot = call.resourceSnapshot ?? snapshotWebhookResources(db, webhook.id, local.id);
  if (resourceSnapshot.ownerNodeId !== local.id || resourceSnapshot.webhookId !== webhook.id) throw new WebhookError(409, "Webhook resources belong to another owner");
  const resources = await resolveWebhookResources(db, resourceSnapshot);
  const memory = resourceSnapshot.memoryEnabled ? await readWebhookMemory(webhook.id) : undefined;
  const resourceContext = webhookResourceInstructions({
    files: resources.files.map(({ name, description, path: filePath }) => ({ name, description, path: filePath })),
    tools: resources.tools.map(({ name, description, usage, path: filePath }) => ({ name, description, usage, path: filePath })),
    skills: resources.skills, memoryPath: memory?.path, memoryCli: memory ? 'node "$JOINT_BOB_WEBHOOK_MEMORY_CLI"' : undefined,
  });
  const attachments = [...(call.attachments ?? [])];
  if (call.body.trim().length > MAX_PAYLOAD_CHARS) attachments.push({ name: PAYLOAD_FILE_NAME, mimeType: "text/plain", data: Buffer.from(call.body) });
  const placed = await placeAttachments(project.path, attachments);
  const titleTemplate = webhook.target.kind === "project" ? webhook.titleTemplate : "";
  const titleInstruction = titleTemplate && titlePlaceholders(titleTemplate).length
    ? `Complete this conversation's title template using the webhook content: ${JSON.stringify(titleTemplate)}. Infer concise text for each bracketed placeholder. Run node "$JOINT_BOB_WEBHOOK_TITLE_CLI" status, then use its fill command with the placeholder replacements. Text outside brackets is fixed and is preserved by the server. Do this before the webhook's main work.`
    : "";
  const message = [titleInstruction, webhookMessage(webhook, call), resourceContext, placed.listed].filter(Boolean).join("\n\n");
  const engine = webhook.target.engine ?? defaultEngine();
  let activeSessionId = webhook.target.kind === "conversation" ? webhook.target.sessionId : null;
  const prompt = {
    automationProfile: automationProfileContext(webhook),
    message, images: placed.images, files: placed.files, requestId: call.requestId!, label: "Webhook", until: "completed" as const,
    onStarted: () => {
      call.started = true;
      const files = call.attachments?.length ? ` with ${call.attachments.length} file${call.attachments.length === 1 ? "" : "s"}` : "";
      const detail = webhook.target.kind === "project" ? `Started conversation ${activeSessionId}${files}` : `Added to the conversation${files}`;
      void clusterV2Database().then(db => {
        transitionAutomationExecution(db, call.requestId!, "running", null, activeSessionId);
        recordWebhookDelivery(db, webhook.id, "delivered", detail);
      });
    },
    onCompleted: () => { void clusterV2Database().then(db => transitionAutomationExecution(db, call.requestId!, "succeeded")); },
    // Apply settings when this turn starts, not while an existing conversation is busy.
    queueSettings: (status: { model: { provider: string; id: string }; thinkingLevel: string }): PromptQueueSettings | undefined => webhook.model || webhook.reasoning ? {
      harnessId: engine,
      provider: webhook.model?.provider ?? status.model.provider,
      modelId: webhook.model?.modelId ?? status.model.id,
      reasoning: webhook.reasoning ?? status.thinkingLevel,
    } : undefined,
  };
  if (!webhook.markForReview) markSilentWebhookRequest(prompt.requestId);
  if (webhook.target.kind === "conversation") {
    const { sessionId, engine } = webhook.target;
    if (!isHarnessId(engine)) throw new WebhookError(409, "The conversation's agent is not available");
    const ownership = await getConversationOwnership(engine, sessionId);
    if (ownership && ownership.ownerNodeId !== local.id) throw new WebhookError(409, "The conversation lives on another machine; create the webhook there");
    bindWebhookConversation(db, webhook.id, project.id, sessionId, local.id);
    await attachSecrets(webhook, engine, sessionId);
    await queueConversationPrompt({ projectId: project.id, engine, sessionId, ...prompt });
    return sessionId;
  }
  if (!isHarnessId(engine) || !listDiscoveredHarnesses().some((adapter) => adapter.id === engine && adapter.runtime)) throw new WebhookError(409, "The webhook's agent is not available on this machine");
  const sessionId = randomUUID();
  activeSessionId = sessionId;
  await ensureConversationRecord(project.id, engine, sessionId, local.id);
  if (titleTemplate) bindWebhookTitle(project.id, sessionId, titleTemplate);
  await ensureSessionTitle(sessionId, titleTemplate || webhook.name);
  broadcastToProject(project.id, { type: "sessionsChanged" });
  try {
    bindWebhookConversation(db, webhook.id, project.id, sessionId, local.id);
    await attachSecrets(webhook, engine, sessionId);
    await queueConversationPrompt({ projectId: project.id, engine, sessionId, ...prompt });
  } catch (error) {
    // The conversation is already listed. It says why it is empty, instead of opening blank.
    recordTurnFailure(engine, sessionId, `Webhook "${webhook.name}" could not start this conversation: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  return sessionId;
}

/** Accepts a call for delivery; the outcome lands in the webhook's call history. */
export function acceptWebhookCall(webhook: Webhook, call: WebhookCall): void {
  const requestId = randomUUID();
  call = { ...call, requestId };
  void (async () => {
    const db = await clusterV2Database();
    const project = await getProject(webhook.target.projectId);
    const local = await getClusterNode();
    const workspace = project ? automationWorkspaceIdentity(db, local.id, project.type ?? "personal") : null;
    const tags = workspace ? snapshotAutomationTags(db, workspace.workspaceId, webhook.tags, workspace.ownerNodeId) : [];
    createAutomationExecution(db, { id: requestId, sourceKind: "webhook", sourceId: webhook.id, sourceName: webhook.name, workspaceId: workspace ? automationWorkspaceKey(workspace) : null, projectId: webhook.target.projectId, ownerNodeId: local.id, engine: webhook.target.kind === "conversation" ? webhook.target.engine : webhook.target.engine ?? null, requestId, sessionId: webhook.target.kind === "conversation" ? webhook.target.sessionId : null, tags, status: "queued", error: null, acceptedAt: new Date().toISOString(), startedAt: null, finishedAt: null });
    try {
      const sessionId = await deliver(webhook, call);
      const files = call.attachments?.length ? ` with ${call.attachments.length} file${call.attachments.length === 1 ? "" : "s"}` : "";
      if (!call.started) recordWebhookDelivery(await clusterV2Database(), webhook.id, "delivered", webhook.target.kind === "project" ? `Started conversation ${sessionId}${files}` : `Added to the conversation${files}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`Webhook ${webhook.id} delivery failed: ${detail}`);
      try {
        const database = await clusterV2Database();
        transitionAutomationExecution(database, call.requestId!, "failed", detail);
        if (!call.started) recordWebhookDelivery(database, webhook.id, "failed", detail);
      } catch { /* history is best effort */ }
    }
  })().catch(error => console.error(`Webhook ${webhook.id} execution setup failed`, error));
}
