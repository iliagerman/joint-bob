import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { getClusterNode } from "../../cluster.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { storedDigest } from "../../conversation-digest.js";
import { nodeSummaryPolicy, saveNodeSummaryPolicy, summaryPolicySchema } from "../../conversation-summary-policy.js";
import { relayServerInstance } from "../../relay/index.js";
import { publishedRelayPolicy, publishRelayPolicy } from "../../relay/resource-policy.js";
import { servingSettings } from "../../relay/store.js";
import { getProject, projectVisible } from "../../store.js";
import type { ProjectRecord } from "../../types.js";
import { DigestError, digestRunning, digestState, requestDigest, summaryPolicyNow, summaryPolicyView } from "../conversation-digest-runner.js";
import { GitReviewRunError } from "../git-review-run.js";
import { sendError } from "../http-auth.js";
import { registeredHarnessIdSchema } from "../schemas.js";
import { listReviewScopeSessions } from "../sessions-helpers.js";
import { app } from "../state.js";

// The agent and model the open conversation is using, as the page sees them.
const digestRequestSchema = z.object({
  conversation: z.object({
    harnessId: registeredHarnessIdSchema,
    provider: z.string().trim().max(200).optional(),
    modelId: z.string().trim().max(300).optional(),
  }).strict().optional(),
}).strict();

async function visibleProject(projectId: string): Promise<ProjectRecord> {
  const project = await getProject(projectId);
  if (!project || !await projectVisible(project.id)) throw new DigestError(404, "Project not found");
  return project;
}

/** Whether the caller can see this conversation; a conversation with no transcript yet is not listed. */
async function conversationListed(project: ProjectRecord, conversationId: string, authSession: AuthSession): Promise<boolean> {
  const sessions = await listReviewScopeSessions(project, authSession.userId, authSession.accountId);
  return sessions.some((session) => (session.conversationId ?? session.id) === conversationId);
}

function sendDigestError(response: Parameters<typeof sendError>[0], error: unknown): boolean {
  if (error instanceof DigestError || error instanceof GitReviewRunError) {
    sendError(response, error.status, error.message);
    return true;
  }
  return false;
}

/** The stored summary and whether the transcript has moved on since it was written. */
app.get("/api/projects/:projectId/conversations/:conversationId/digest", async (request, response, next) => {
  try {
    const { projectId, conversationId } = request.params;
    const project = await visibleProject(projectId);
    const policy = summaryPolicyView(await summaryPolicyNow());
    // A conversation that has not started has nothing to summarize yet; that is not an error.
    if (!await conversationListed(project, conversationId, response.locals.authSession as AuthSession)) {
      response.json({ digest: null, stale: false, turns: 0, refreshing: false, policy });
      return;
    }
    try {
      response.json({ ...await digestState(project, conversationId), refreshing: digestRunning(project.id, conversationId), policy });
    } catch (error) {
      // Listed but not readable here, such as a transcript still arriving from another node.
      if (!(error instanceof DigestError)) throw error;
      const digest = storedDigest(project.id, conversationId) ?? null;
      response.json({ digest, stale: false, turns: digest?.turns ?? 0, unavailable: true, refreshing: false, policy });
    }
  } catch (error) {
    if (!sendDigestError(response, error)) next(error);
  }
});

/**
 * Brings the summary up to date with the transcript, reading only the messages it has not seen.
 * The model failing to write one is reported in the body with the summary that is still
 * stored, like a change story's error line: the request itself was fine.
 */
app.post("/api/projects/:projectId/conversations/:conversationId/digest", async (request, response, next) => {
  try {
    const { projectId, conversationId } = request.params;
    const project = await visibleProject(projectId);
    const { conversation } = digestRequestSchema.parse(request.body ?? {});
    if (!await conversationListed(project, conversationId, response.locals.authSession as AuthSession)) throw new DigestError(404, "Conversation not found");
    try {
      response.json({ digest: await requestDigest(project, conversationId, conversation), stale: false });
    } catch (error) {
      if (!(error instanceof DigestError) && !(error instanceof GitReviewRunError)) console.warn("Conversation summary failed", error);
      response.json({ digest: storedDigest(project.id, conversationId) ?? null, stale: true, error: error instanceof Error ? error.message : "The summary could not be written" });
    }
  } catch (error) {
    if (!sendDigestError(response, error)) next(error);
  }
});

/** This node's summary policy, the one in force (a joined relay's wins), and the one this node publishes as a relay. */
app.get("/api/conversation-summary/settings", async (_request, response, next) => {
  try {
    const db = await clusterV2Database();
    const effective = await summaryPolicyNow();
    response.json({
      node: nodeSummaryPolicy(),
      effective: { ...effective, view: summaryPolicyView(effective) },
      relayServing: servingSettings(db).enabled ? { policy: publishedRelayPolicy(db, (await getClusterNode()).id).body.summary ?? null } : null,
    });
  } catch (error) {
    next(error);
  }
});

/** Admin only (see ADMIN_ROUTES): this node's own policy. */
app.put("/api/conversation-summary/settings", async (request, response, next) => {
  try {
    response.json({ node: saveNodeSummaryPolicy(summaryPolicySchema.parse(request.body)) });
  } catch (error) {
    next(error);
  }
});

/** Admin only: the policy this node, as a relay, publishes to its machines; null leaves it to each machine. */
app.put("/api/conversation-summary/relay-policy", async (request, response, next) => {
  try {
    const { policy } = z.object({ policy: summaryPolicySchema.nullable() }).strict().parse(request.body);
    const db = await clusterV2Database();
    if (!servingSettings(db).enabled) { sendError(response, 409, "This machine does not serve a relay"); return; }
    const nodeId = (await getClusterNode()).id;
    const current = publishedRelayPolicy(db, nodeId).body;
    const statement = publishRelayPolicy(db, nodeId, current.rules, { settings: current.settings, enabled: current.enabled, skillDigests: current.skillDigests }, policy);
    relayServerInstance()?.broadcastSkillPolicy();
    response.json({ policy: statement.body.summary ?? null });
  } catch (error) {
    next(error);
  }
});
