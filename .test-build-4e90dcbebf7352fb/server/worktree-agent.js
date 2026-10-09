import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { ensureConversationRecord } from "../conversation-records.js";
import { githubAccountFor } from "../github-credentials.js";
import { ensureSessionTitle } from "../names.js";
import {
  createProjectWorktree,
  deleteProjectWorktree,
  getProjectWorktree,
  listProjectWorktrees,
  ProjectWorktreeError,
  recordWorktreePullRequest,
  worktreeChanges,
  worktreeConversationIndex
} from "../project-worktrees.js";
import { conversationLeaseRunning } from "../conversation-runtime.js";
import { conversationScopeId, genericSecretEnvironment, getScopeSecretAccounts, githubAccountsForProject, persistConversationSecretAccounts } from "../secrets.js";
import { getProject } from "../store.js";
import { isHarnessId, PROJECT_COLORS } from "../types.js";
import { queueConversationPrompt } from "./conversation-prompt.js";
import { openWorktreePullRequest } from "./github-pull-request.js";
import { findHarnessSession, harnessSessionBusy } from "./harness-sessions.js";
import { assertProjectEditable } from "./projects.js";
import { broadcastToProject } from "./realtime.js";
const worktreeId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const worktreeAgentRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list") }).strict(),
  z.object({ operation: z.literal("create"), name: z.string().max(200), color: z.enum(PROJECT_COLORS).optional() }).strict(),
  z.object({ operation: z.literal("start"), worktreeId, prompt: z.string().trim().min(1).max(1e5), title: z.string().trim().min(1).max(120).optional() }).strict(),
  z.object({ operation: z.literal("pr"), worktreeId: worktreeId.optional(), title: z.string().trim().min(1).max(256), body: z.string().max(6e4).default(""), base: z.string().trim().min(1).max(200).optional() }).strict(),
  z.object({ operation: z.literal("delete"), worktreeId }).strict()
]);
async function callerWorktree(identity, projectId) {
  const index = await worktreeConversationIndex(projectId);
  return index.get(`${identity.engine}:${identity.sessionId}`) ?? index.get(`${identity.engine}:${identity.conversationId}`);
}
async function runningConversations(projectId, worktree) {
  const running = [];
  for (const [key, candidate] of await worktreeConversationIndex(projectId)) {
    if (candidate.id !== worktree.id) continue;
    const [engine, sessionId] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    if (!isHarnessId(engine)) continue;
    const local = findHarnessSession(projectId, engine, sessionId);
    if (local && harnessSessionBusy(local) || conversationLeaseRunning(engine, sessionId)) running.push(sessionId);
  }
  return running;
}
function createdByCaller(worktree, identity) {
  return worktree.createdBy?.engine === identity.engine && [identity.conversationId, identity.sessionId].includes(worktree.createdBy.conversationId);
}
async function localWorktree(projectId, id) {
  const worktree = await getProjectWorktree(projectId, id);
  if (!worktree) throw new ProjectWorktreeError(404, "Worktree not found on this node");
  return worktree;
}
function pullRequestBranch(worktree) {
  const slug = worktree.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "worktree";
  return `joint-bob/${slug}-${worktree.id.slice(0, 8)}`;
}
async function startConversation(identity, project, worktree, prompt, title) {
  const sessionId = randomUUID();
  await ensureConversationRecord(project.id, identity.engine, sessionId, (await getClusterNode()).id);
  await ensureSessionTitle(sessionId, title ?? worktree.name);
  const { accountIds } = await getScopeSecretAccounts("conversation", conversationScopeId(identity.engine, identity.sessionId));
  await persistConversationSecretAccounts(identity.engine, sessionId, accountIds);
  try {
    await queueConversationPrompt({ projectId: project.id, engine: identity.engine, sessionId, message: prompt, requestId: randomUUID(), label: "Worktree", worktreeId: worktree.id, until: "started" });
  } catch (error) {
    throw new ProjectWorktreeError(502, `Conversation ${sessionId} did not start: ${error instanceof Error ? error.message : String(error)}`);
  }
  broadcastToProject(project.id, { type: "sessionsChanged" });
  return { conversationId: sessionId, engine: identity.engine, worktreeId: worktree.id, secretAccounts: accountIds.length };
}
async function openPullRequest(identity, project, worktree, input) {
  const conversation = { engine: identity.engine, sessionId: identity.sessionId };
  const accounts = githubAccountsForProject(project.id, conversation);
  const fallback = genericSecretEnvironment(project.id, conversation).GH_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const result = await openWorktreePullRequest({
    projectPath: project.path,
    branchName: pullRequestBranch(worktree),
    title: input.title,
    body: input.body,
    base: input.base,
    changes: await worktreeChanges(project.id, worktree.id),
    previous: worktree.pullRequest
  }, {
    tokenFor: (repository) => githubAccountFor(accounts, repository)?.token ?? fallback,
    sshHosts: accounts.filter((account) => account.sshKey).map((account) => account.sshHost)
  });
  await recordWorktreePullRequest(project.id, worktree.id, result.pullRequest);
  broadcastToProject(project.id, { type: "worktreesChanged" });
  return { worktreeId: worktree.id, ...result };
}
async function worktreeAgentRequest(identity, request) {
  const project = await getProject(identity.projectId);
  if (!project) throw new ProjectWorktreeError(404, "Project not found");
  const current = await callerWorktree(identity, project.id);
  switch (request.operation) {
    case "list": {
      const worktrees = await listProjectWorktrees(project.id);
      return {
        worktrees: worktrees.map((worktree) => ({
          id: worktree.id,
          name: worktree.name,
          path: worktree.path,
          createdAt: worktree.createdAt,
          lastMergedAt: worktree.lastMergedAt,
          pullRequest: worktree.pullRequest,
          current: worktree.id === current?.id,
          createdByThisConversation: createdByCaller(worktree, identity)
        }))
      };
    }
    case "create": {
      await assertProjectEditable(project);
      const worktree = await createProjectWorktree(project, { name: request.name, color: request.color, createdBy: { engine: identity.engine, conversationId: identity.conversationId } });
      broadcastToProject(project.id, { type: "worktreesChanged" });
      return { worktree: { id: worktree.id, name: worktree.name, path: worktree.path, color: worktree.color } };
    }
    case "start": {
      await assertProjectEditable(project);
      return startConversation(identity, project, await localWorktree(project.id, request.worktreeId), request.prompt, request.title);
    }
    case "pr": {
      if (!request.worktreeId && !current) throw new ProjectWorktreeError(400, "This conversation does not run in a worktree; pass --worktree ID");
      return openPullRequest(identity, project, request.worktreeId ? await localWorktree(project.id, request.worktreeId) : current, request);
    }
    case "delete": {
      await assertProjectEditable(project);
      const worktree = await localWorktree(project.id, request.worktreeId);
      if (worktree.id === current?.id) throw new ProjectWorktreeError(409, "A conversation cannot delete the worktree it runs in");
      if (!createdByCaller(worktree, identity)) throw new ProjectWorktreeError(403, "Only the conversation that created this worktree may delete it; ask the user");
      const running = await runningConversations(project.id, worktree);
      if (running.length) throw new ProjectWorktreeError(409, `Conversation ${running.join(", ")} is still running in this worktree; let it finish with pr, then delete`);
      await deleteProjectWorktree(project.id, worktree.id);
      broadcastToProject(project.id, { type: "worktreesChanged" });
      broadcastToProject(project.id, { type: "sessionsChanged" });
      return { deleted: worktree.id };
    }
  }
}
export {
  pullRequestBranch,
  worktreeAgentRequest,
  worktreeAgentRequestSchema
};
