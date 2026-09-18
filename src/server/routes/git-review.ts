import { realpath } from "node:fs/promises";
import type { Request, Response } from "express";
import { type ClusterPeer, getClusterNode, getClusterPeer } from "../../cluster.js";
import {
  gitCommitDetail,
  gitCommitFileDiff,
  gitCommitHistory,
  gitFileDiff,
  GitReviewError,
  gitStatus,
} from "../../git-review.js";
import {
  appendGitReviewMessages,
  createGitReviewThread,
  deleteGitReviewThread,
  getGitReviewThread,
  listGitReviewThreads,
  type GitReviewSelection,
} from "../../git-review-threads.js";
import { getProject } from "../../store.js";
import { listTasks } from "../../tasks.js";
import { sendError } from "../http-auth.js";
import { GitReviewRunError, runGitReview } from "../git-review-run.js";
import { gitReviewAskSchema, gitReviewFollowUpSchema } from "../schemas.js";
import { app } from "../state.js";

// The review cwd is the ticket worktree when a task is in scope, else the project root.
// A ticket-scoped request routes to the task owner, exactly like project-files, because a
// replica holds no worktree.
async function reviewCwd(projectId: string, taskId?: string): Promise<string> {
  const project = await getProject(projectId);
  if (!project) throw new GitReviewError(404, "Project not found");
  if (!taskId) return await realpath(project.path);
  const task = (await listTasks(projectId)).find((candidate) => candidate.id === taskId);
  if (!task) throw new GitReviewError(404, "Ticket was not found");
  if (!task.worktreePath) throw new GitReviewError(404, "Ticket workspace is not available");
  return await realpath(task.worktreePath);
}

async function taskOwnerNodeId(projectId: string, taskId: string, fallback: string): Promise<string> {
  const task = (await listTasks(projectId)).find((candidate) => candidate.id === taskId);
  return task?.currentNodeId ?? fallback;
}

function queryString(request: Request, name: string): string {
  const value = request.query[name];
  return typeof value === "string" ? value : "";
}

function queryOptional(request: Request, name: string): string | undefined {
  const value = request.query[name];
  return typeof value === "string" && value ? value : undefined;
}

// Forwards a JSON git request to the owning peer's cluster route, passing the response through.
async function proxyGitJson(response: Response, peer: ClusterPeer, clusterRoute: string, query: Record<string, string | undefined>, request?: Request): Promise<void> {
  const url = new URL(clusterRoute, peer.url);
  for (const [key, value] of Object.entries(query)) if (value) url.searchParams.set(key, value);
  const routed = await fetch(url, {
    method: request?.method ?? "GET",
    headers: { Authorization: `Bearer ${peer.token}`, ...(request ? { "Content-Type": "application/json" } : {}) },
    ...(request ? { body: JSON.stringify(request.body) } : {}),
    // A review turn can take minutes; the ask route needs a longer ceiling than reads.
    signal: AbortSignal.timeout(request ? 6 * 60_000 : 30_000),
  });
  const contentType = routed.headers.get("content-type");
  if (contentType) response.setHeader("Content-Type", contentType);
  response.status(routed.status).send(await routed.text());
}

// Resolves the node that owns the request, forwarding to it when it is a peer.
async function withOwningNode(
  request: Request,
  response: Response,
  clusterRoute: string,
  query: Record<string, string | undefined>,
  local: () => Promise<unknown>,
  forwardRequest?: Request,
): Promise<void> {
  const projectId = request.params.projectId;
  const taskId = queryOptional(request, "taskId");
  let nodeId = queryString(request, "nodeId");
  const localNode = await getClusterNode();
  if (taskId) nodeId = await taskOwnerNodeId(projectId, taskId, nodeId);
  if (nodeId && nodeId !== localNode.id) {
    const peer = await getClusterPeer(nodeId);
    if (!peer) { sendError(response, 404, "Git node not found"); return; }
    await proxyGitJson(response, peer, clusterRoute, { ...query, projectId, taskId }, forwardRequest);
    return;
  }
  response.json(await local());
}

function handleGitError(response: Response, error: unknown, next: (error?: unknown) => void): void {
  if (error instanceof GitReviewError || error instanceof GitReviewRunError) { sendError(response, error.status, error.message); return; }
  next(error);
}

// ---- Status ----

app.get("/api/cluster/git/status", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const cwd = await reviewCwd(queryString(request, "projectId"), queryOptional(request, "taskId"));
    response.json(await gitStatus(cwd));
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/projects/:projectId/git/status", async (request, response, next) => {
  try {
    await withOwningNode(request, response, "/api/cluster/git/status", {}, async () =>
      gitStatus(await reviewCwd(request.params.projectId, queryOptional(request, "taskId"))));
  } catch (error) { handleGitError(response, error, next); }
});

// ---- Working-tree file diff ----

app.get("/api/cluster/git/diff", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const cwd = await reviewCwd(queryString(request, "projectId"), queryOptional(request, "taskId"));
    response.json(await gitFileDiff(cwd, queryString(request, "path"), { staged: request.query.staged === "1", untracked: request.query.untracked === "1" }));
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/projects/:projectId/git/diff", async (request, response, next) => {
  try {
    await withOwningNode(request, response, "/api/cluster/git/diff", { path: queryString(request, "path"), staged: request.query.staged === "1" ? "1" : undefined, untracked: request.query.untracked === "1" ? "1" : undefined }, async () =>
      gitFileDiff(await reviewCwd(request.params.projectId, queryOptional(request, "taskId")), queryString(request, "path"), { staged: request.query.staged === "1", untracked: request.query.untracked === "1" }));
  } catch (error) { handleGitError(response, error, next); }
});

// ---- Commit history ----

app.get("/api/cluster/git/history", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const cwd = await reviewCwd(queryString(request, "projectId"), queryOptional(request, "taskId"));
    response.json({ commits: await gitCommitHistory(cwd, Number(queryString(request, "limit")) || 50, Number(queryString(request, "skip")) || 0) });
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/projects/:projectId/git/history", async (request, response, next) => {
  try {
    await withOwningNode(request, response, "/api/cluster/git/history", { limit: queryOptional(request, "limit"), skip: queryOptional(request, "skip") }, async () =>
      ({ commits: await gitCommitHistory(await reviewCwd(request.params.projectId, queryOptional(request, "taskId")), Number(queryString(request, "limit")) || 50, Number(queryString(request, "skip")) || 0) }));
  } catch (error) { handleGitError(response, error, next); }
});

// ---- Commit detail (files + full diff) ----

app.get("/api/cluster/git/commit", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const cwd = await reviewCwd(queryString(request, "projectId"), queryOptional(request, "taskId"));
    response.json(await gitCommitDetail(cwd, queryString(request, "revision")));
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/projects/:projectId/git/commit", async (request, response, next) => {
  try {
    await withOwningNode(request, response, "/api/cluster/git/commit", { revision: queryString(request, "revision") }, async () =>
      gitCommitDetail(await reviewCwd(request.params.projectId, queryOptional(request, "taskId")), queryString(request, "revision")));
  } catch (error) { handleGitError(response, error, next); }
});

// ---- Commit file diff ----

app.get("/api/cluster/git/commit-diff", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const cwd = await reviewCwd(queryString(request, "projectId"), queryOptional(request, "taskId"));
    response.json(await gitCommitFileDiff(cwd, queryString(request, "revision"), queryString(request, "path")));
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/projects/:projectId/git/commit-diff", async (request, response, next) => {
  try {
    await withOwningNode(request, response, "/api/cluster/git/commit-diff", { revision: queryString(request, "revision"), path: queryString(request, "path") }, async () =>
      gitCommitFileDiff(await reviewCwd(request.params.projectId, queryOptional(request, "taskId")), queryString(request, "revision"), queryString(request, "path")));
  } catch (error) { handleGitError(response, error, next); }
});

// ---- Review threads (list / delete) ----

app.get("/api/projects/:projectId/git/reviews", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    // A conversationId filter returns only that conversation's reviews; its absence lists all.
    const conversationId = queryOptional(request, "conversationId");
    const threads = request.query.conversationId === undefined
      ? listGitReviewThreads(project.id)
      : listGitReviewThreads(project.id, conversationId ?? null);
    response.json({ threads });
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/projects/:projectId/git/reviews/:threadId", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const thread = getGitReviewThread(request.params.threadId);
    if (!thread || thread.projectId !== project.id) { sendError(response, 404, "Review not found"); return; }
    response.json({ thread });
  } catch (error) { handleGitError(response, error, next); }
});

app.delete("/api/projects/:projectId/git/reviews/:threadId", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const thread = getGitReviewThread(request.params.threadId);
    if (!thread || thread.projectId !== project.id) { sendError(response, 404, "Review not found"); return; }
    deleteGitReviewThread(request.params.threadId);
    response.status(204).send();
  } catch (error) { handleGitError(response, error, next); }
});

// ---- Ask AI (new review) ----

// The diff for a selection, fetched on the owning node before the review runs there.
async function selectionDiff(cwd: string, selection: GitReviewSelection): Promise<string> {
  if (selection.scope === "commit") {
    if (!selection.revision) throw new GitReviewError(400, "A commit review needs a revision");
    if (selection.filePath) return (await gitCommitFileDiff(cwd, selection.revision, selection.filePath)).patch;
    return (await gitCommitDetail(cwd, selection.revision)).diff.patch;
  }
  if (selection.filePath) {
    // An untracked file has no index entry, so its diff comes from the empty-blob path.
    const status = await gitStatus(cwd);
    const untracked = !selection.staged && status.untracked.some((change) => change.path === selection.filePath);
    const diff = await gitFileDiff(cwd, selection.filePath, { staged: selection.staged, untracked });
    return diff.patch;
  }
  // A whole-worktree question uses the combined status diff.
  const status = await gitStatus(cwd);
  const parts: string[] = [];
  for (const change of [...status.staged, ...status.unstaged]) {
    parts.push((await gitFileDiff(cwd, change.path, { staged: change.staged })).patch);
  }
  return parts.filter(Boolean).join("\n");
}

app.post("/api/cluster/git/ask", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const projectId = queryString(request, "projectId");
    const payload = gitReviewAskSchema.parse(request.body);
    const cwd = await reviewCwd(projectId, queryOptional(request, "taskId"));
    response.json(await performAsk(projectId, cwd, payload));
  } catch (error) { handleGitError(response, error, next); }
});

async function performAsk(projectId: string, cwd: string, payload: ReturnType<typeof gitReviewAskSchema.parse>): Promise<unknown> {
  const diff = await selectionDiff(cwd, payload.selection);
  const result = await runGitReview({
    projectId,
    cwd,
    harnessId: payload.harnessId,
    provider: payload.provider ?? "",
    modelId: payload.modelId,
    thinkingLevel: payload.thinkingLevel,
    selection: payload.selection,
    diff,
    question: payload.question,
  });
  const thread = createGitReviewThread({
    projectId,
    conversationId: payload.conversationId ?? null,
    harnessId: payload.harnessId,
    provider: result.provider,
    modelId: result.modelId,
    thinkingLevel: result.thinkingLevel,
    selection: payload.selection,
    snapshot: diff,
    question: payload.question,
    answer: result.answer,
  });
  return { thread };
}

app.post("/api/projects/:projectId/git/ask", async (request, response, next) => {
  try {
    const projectId = request.params.projectId;
    const taskId = queryOptional(request, "taskId");
    let nodeId = queryString(request, "nodeId");
    const localNode = await getClusterNode();
    if (taskId) nodeId = await taskOwnerNodeId(projectId, taskId, nodeId);
    if (nodeId && nodeId !== localNode.id) {
      const peer = await getClusterPeer(nodeId);
      if (!peer) { sendError(response, 404, "Git node not found"); return; }
      await proxyGitJson(response, peer, "/api/cluster/git/ask", { projectId, taskId }, request);
      return;
    }
    const payload = gitReviewAskSchema.parse(request.body);
    const cwd = await reviewCwd(projectId, taskId);
    response.json(await performAsk(projectId, cwd, payload));
  } catch (error) { handleGitError(response, error, next); }
});

// ---- Ask AI follow-up (continues an existing thread) ----

async function performFollowUp(projectId: string, cwd: string, threadId: string, question: string): Promise<unknown> {
  const thread = getGitReviewThread(threadId);
  if (!thread || thread.projectId !== projectId) throw new GitReviewError(404, "Review not found");
  const result = await runGitReview({
    projectId,
    cwd,
    harnessId: thread.harnessId,
    provider: thread.provider,
    modelId: thread.modelId,
    thinkingLevel: thread.thinkingLevel,
    selection: thread.selection,
    // The follow-up reviews the same preserved snapshot, so an intervening edit does not
    // silently change what the review was about.
    diff: thread.snapshot,
    question,
    history: thread.messages.map((message) => ({ role: message.role, text: message.text })),
  });
  const updated = appendGitReviewMessages(threadId, question, result.answer);
  if (!updated) throw new GitReviewError(404, "Review expired");
  return { thread: updated };
}

app.post("/api/cluster/git/reviews/ask", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const projectId = queryString(request, "projectId");
    const threadId = queryString(request, "threadId");
    const payload = gitReviewFollowUpSchema.parse(request.body);
    const cwd = await reviewCwd(projectId, queryOptional(request, "taskId"));
    response.json(await performFollowUp(projectId, cwd, threadId, payload.question));
  } catch (error) { handleGitError(response, error, next); }
});

app.post("/api/projects/:projectId/git/reviews/:threadId/ask", async (request, response, next) => {
  try {
    const projectId = request.params.projectId;
    const taskId = queryOptional(request, "taskId");
    let nodeId = queryString(request, "nodeId");
    const localNode = await getClusterNode();
    if (taskId) nodeId = await taskOwnerNodeId(projectId, taskId, nodeId);
    if (nodeId && nodeId !== localNode.id) {
      const peer = await getClusterPeer(nodeId);
      if (!peer) { sendError(response, 404, "Git node not found"); return; }
      await proxyGitJson(response, peer, "/api/cluster/git/reviews/ask", { projectId, taskId, threadId: request.params.threadId }, request);
      return;
    }
    const payload = gitReviewFollowUpSchema.parse(request.body);
    const cwd = await reviewCwd(projectId, taskId);
    response.json(await performFollowUp(projectId, cwd, request.params.threadId, payload.question));
  } catch (error) { handleGitError(response, error, next); }
});
