import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { Request, Response } from "express";
import { type ClusterPeer, getClusterNode } from "../../cluster.js";
import { getRuntimePeer, runtimeFetch } from "../runtime-peers.js";
import {
  gitCommitDetail,
  gitCommitFileDiff,
  gitCommitHistory,
  gitPushHistory,
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
  type GitReviewThread,
} from "../../git-review-threads.js";
import { CHANGE_STORY_MARKER, conversationCommits, generateChangeStory, storyFreshness, type SavedChangeStory, type StorySources } from "../git-change-story.js";
import { getProject } from "../../store.js";
import { genericSecretEnvironment, githubAccountsForProject } from "../../secrets.js";
import { githubAccountFor } from "../../github-credentials.js";
import { createGitHubReview } from "../github-review.js";
import { listTasks } from "../../tasks.js";
import { sendError } from "../http-auth.js";
import { GitReviewRunError, runGitReview } from "../git-review-run.js";
import { checkedConversationFiles, conversationReviewContext, discoverConversationFiles, generateReviewGuide, pendingReviewDiff } from "../git-review-guide.js";
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
  const routed = await runtimeFetch(url, {
    method: request?.method ?? "GET",
    headers: { ...(request ? { "Content-Type": "application/json" } : {}) },
    ...(request ? { body: JSON.stringify(request.body) } : {}),
    // A review turn can take minutes; the ask route needs a longer ceiling than reads.
    signal: AbortSignal.timeout(request ? 6 * 60_000 : 30_000),
  });
  const contentType = routed.headers.get("content-type");
  if (contentType) response.setHeader("Content-Type", contentType);
  // A peer rejecting our machine token (401/403) is a node-to-node auth problem, not the
  // browser user's session expiring. Passing that 401 straight through makes the client
  // show a spurious sign-in dialog, so it is reported as an upstream (502) failure instead.
  // The usual cause is the peer running an older build without the git cluster routes.
  if (routed.status === 401 || routed.status === 403) {
    const detail = await routed.text().catch(() => "");
    response.status(502).json({ error: `Git node rejected the request (HTTP ${routed.status}). It may be running an older Joint Bob version; update every node.${detail ? ` Details: ${detail.slice(0, 200)}` : ""}` });
    return;
  }
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
    const peer = await getRuntimePeer(nodeId);
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

// ---- GitHub pull requests and Actions ----

const githubQuery = z.object({
  op: z.enum(["pulls", "pull", "runs", "run", "log"]),
  state: z.enum(["open", "closed"]).optional(),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  id: z.coerce.number().int().positive().optional(),
});
const githubAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("comment"), number: z.number().int().positive(), body: z.string().trim().min(1).max(65536) }).strict(),
  z.object({ action: z.literal("review"), number: z.number().int().positive(), event: z.enum(["APPROVE", "REQUEST_CHANGES"]), body: z.string().max(65536) }).strict(),
  z.object({ action: z.literal("close"), number: z.number().int().positive() }).strict(),
]);

async function githubClient(projectId: string, taskId?: string) {
  const cwd = await reviewCwd(projectId, taskId);
  const accounts = githubAccountsForProject(projectId);
  const fallback = genericSecretEnvironment(projectId).GH_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  return createGitHubReview(cwd, {
    tokenFor: (repository) => githubAccountFor(accounts, repository)?.token ?? fallback,
    sshHosts: accounts.filter((account) => account.sshKey).map((account) => account.sshHost),
  });
}

async function githubRead(projectId: string, taskId: string | undefined, query: Record<string, unknown>) {
  const parsed = githubQuery.safeParse(query);
  if (!parsed.success) throw new GitReviewError(400, "Invalid GitHub request");
  const { op, id, page = 1, state = "open" } = parsed.data;
  const github = await githubClient(projectId, taskId);
  if (op === "pulls") return { repository: github.repository, pulls: await github.pulls(state, page) };
  if (op === "runs") return { repository: github.repository, runs: await github.runs(page) };
  if (!id) throw new GitReviewError(400, "GitHub item ID required");
  if (op === "pull") return github.pull(id);
  if (op === "run") return github.run(id);
  return github.log(id);
}

async function githubWrite(projectId: string, taskId: string | undefined, body: unknown) {
  const parsed = githubAction.safeParse(body);
  if (!parsed.success) throw new GitReviewError(400, "Invalid GitHub action");
  const github = await githubClient(projectId, taskId);
  const action = parsed.data;
  if (action.action === "comment") return github.comment(action.number, action.body);
  if (action.action === "close") return github.close(action.number);
  return github.review(action.number, action.event, action.body);
}

app.get("/api/cluster/git/github", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    response.json(await githubRead(queryString(request, "projectId"), queryOptional(request, "taskId"), request.query));
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/projects/:projectId/git/github", async (request, response, next) => {
  try {
    const query = { op: queryOptional(request, "op"), id: queryOptional(request, "id"), state: queryOptional(request, "state"), page: queryOptional(request, "page") };
    await withOwningNode(request, response, "/api/cluster/git/github", query, async () =>
      githubRead(request.params.projectId, queryOptional(request, "taskId"), query));
  } catch (error) { handleGitError(response, error, next); }
});

app.post("/api/cluster/git/github", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    response.json(await githubWrite(queryString(request, "projectId"), queryOptional(request, "taskId"), request.body));
  } catch (error) { handleGitError(response, error, next); }
});

app.post("/api/projects/:projectId/git/github", async (request, response, next) => {
  try {
    await withOwningNode(request, response, "/api/cluster/git/github", {}, async () =>
      githubWrite(request.params.projectId, queryOptional(request, "taskId"), request.body), request);
  } catch (error) { handleGitError(response, error, next); }
});

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

function reviewList(projectId: string, conversationId: string | undefined): unknown {
  return { threads: conversationId === undefined ? listGitReviewThreads(projectId) : listGitReviewThreads(projectId, conversationId) };
}

function reviewDetail(projectId: string, threadId: string): unknown {
  const thread = getGitReviewThread(threadId);
  if (!thread || thread.projectId !== projectId) throw new GitReviewError(404, "Review not found");
  return { thread };
}

app.get("/api/cluster/git/reviews", (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    response.json(reviewList(queryString(request, "projectId"), queryOptional(request, "conversationId")));
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/projects/:projectId/git/reviews", async (request, response, next) => {
  try {
    await withOwningNode(request, response, "/api/cluster/git/reviews", { conversationId: queryOptional(request, "conversationId") }, async () => {
      if (!await getProject(request.params.projectId)) throw new GitReviewError(404, "Project not found");
      return reviewList(request.params.projectId, queryOptional(request, "conversationId"));
    });
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/cluster/git/review", (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    response.json(reviewDetail(queryString(request, "projectId"), queryString(request, "threadId")));
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/projects/:projectId/git/reviews/:threadId", async (request, response, next) => {
  try {
    await withOwningNode(request, response, "/api/cluster/git/review", { threadId: request.params.threadId }, async () => {
      if (!await getProject(request.params.projectId)) throw new GitReviewError(404, "Project not found");
      return reviewDetail(request.params.projectId, request.params.threadId);
    });
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

// ---- Conversation file scope and guided review ----

const guideRequest = z.object({
  conversationId: z.string().min(1).max(240).nullable(),
  scope: z.enum(["conversation", "all"]),
  paths: z.array(z.string().min(1).max(2000)).min(1).max(100),
  harnessId: gitReviewAskSchema.shape.harnessId,
  provider: z.string().max(200).optional(),
  modelId: z.string().min(1).max(300),
  thinkingLevel: gitReviewAskSchema.shape.thinkingLevel,
}).strict();

async function discoverScope(projectId: string, cwd: string, conversationId: string, refresh: boolean): Promise<unknown> {
  const project = await getProject(projectId);
  if (!project) throw new GitReviewError(404, "Project not found");
  return discoverConversationFiles(project, cwd, conversationId, refresh);
}

app.get("/api/cluster/git/scope", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    response.json(await discoverScope(queryString(request, "projectId"), await reviewCwd(queryString(request, "projectId"), queryOptional(request, "taskId")), queryString(request, "conversationId"), queryOptional(request, "refresh") === "1"));
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/projects/:projectId/git/scope", async (request, response, next) => {
  try {
    const conversationId = queryString(request, "conversationId");
    if (!conversationId) throw new GitReviewError(400, "Conversation required");
    const refresh = queryOptional(request, "refresh") === "1";
    await withOwningNode(request, response, "/api/cluster/git/scope", { conversationId, ...(refresh ? { refresh: "1" } : {}) }, async () =>
      discoverScope(request.params.projectId, await reviewCwd(request.params.projectId, queryOptional(request, "taskId")), conversationId, refresh));
  } catch (error) { handleGitError(response, error, next); }
});

async function performGuide(projectId: string, cwd: string, input: z.infer<typeof guideRequest>): Promise<unknown> {
  const project = await getProject(projectId);
  if (!project) throw new GitReviewError(404, "Project not found");
  if (input.scope === "conversation" && !input.conversationId) throw new GitReviewError(400, "Conversation required");
  if (input.scope === "conversation") checkedConversationFiles(projectId, cwd, input.conversationId!, input.paths);
  const status = await gitStatus(cwd);
  const pending = new Set([...status.staged, ...status.unstaged, ...status.untracked].map(({ path }) => path));
  if (input.paths.some((file) => !pending.has(file))) throw new GitReviewError(409, "Selected files changed; refresh Git status");
  const context = input.conversationId ? await conversationReviewContext(project, input.conversationId) : { transcript: "Project-wide pending changes", lastHarness: "" };
  const result = await generateReviewGuide({ projectId, cwd, paths: input.paths, transcript: context.transcript, lastHarness: context.lastHarness, harnessId: input.harnessId, provider: input.provider ?? "", modelId: input.modelId, thinkingLevel: input.thinkingLevel });
  if ((await pendingReviewDiff(cwd, input.paths)).fingerprint !== result.fingerprint) throw new GitReviewError(409, "Pending changes changed during review; generate again");
  const thread = createGitReviewThread({ projectId, conversationId: input.conversationId, harnessId: input.harnessId, provider: input.provider ?? "", modelId: input.modelId, thinkingLevel: input.thinkingLevel, selection: { scope: "worktree" }, snapshot: result.diff, question: "Generated review comments", answer: JSON.stringify({ guide: result.guide, paths: input.paths, patches: result.patches, fingerprint: result.fingerprint, scope: input.scope }) });
  return { thread, guide: result.guide, patches: result.patches, fingerprint: result.fingerprint };
}

app.post("/api/cluster/git/guide", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const projectId = queryString(request, "projectId");
    response.json(await performGuide(projectId, await reviewCwd(projectId, queryOptional(request, "taskId")), guideRequest.parse(request.body)));
  } catch (error) { handleGitError(response, error, next); }
});

app.post("/api/projects/:projectId/git/guide", async (request, response, next) => {
  try {
    await withOwningNode(request, response, "/api/cluster/git/guide", {}, async () =>
      performGuide(request.params.projectId, await reviewCwd(request.params.projectId, queryOptional(request, "taskId")), guideRequest.parse(request.body)), request);
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/cluster/git/guide-fresh", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const thread = getGitReviewThread(queryString(request, "threadId"));
    if (!thread || thread.projectId !== queryString(request, "projectId")) throw new GitReviewError(404, "Review not found");
    const saved = JSON.parse(thread.messages[1].text) as { paths: string[]; fingerprint: string };
    const current = await pendingReviewDiff(await reviewCwd(thread.projectId, queryOptional(request, "taskId")), saved.paths);
    response.json({ fresh: current.fingerprint === saved.fingerprint });
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/projects/:projectId/git/guide-fresh", async (request, response, next) => {
  try {
    await withOwningNode(request, response, "/api/cluster/git/guide-fresh", { threadId: queryString(request, "threadId") }, async () => {
      const thread = getGitReviewThread(queryString(request, "threadId"));
      if (!thread || thread.projectId !== request.params.projectId) throw new GitReviewError(404, "Review not found");
      const saved = JSON.parse(thread.messages[1].text) as { paths: string[]; fingerprint: string };
      const current = await pendingReviewDiff(await reviewCwd(thread.projectId, queryOptional(request, "taskId")), saved.paths);
      return { fresh: current.fingerprint === saved.fingerprint };
    });
  } catch (error) { handleGitError(response, error, next); }
});

// The newest generated review for a conversation (or the whole project), only while its diff is unchanged.
async function latestFreshGuide(projectId: string, cwd: string, conversationId: string | null): Promise<unknown> {
  const summary = listGitReviewThreads(projectId, conversationId).find((thread) => thread.question === "Generated review comments");
  if (!summary) return { latest: null };
  const thread = getGitReviewThread(summary.id)!;
  const saved = JSON.parse(thread.messages[1].text) as { guide: unknown; paths: string[]; patches: Record<string, string>; fingerprint: string; scope: string };
  if ((await pendingReviewDiff(cwd, saved.paths)).fingerprint !== saved.fingerprint) return { latest: null };
  return { thread: { id: thread.id }, ...saved };
}

app.get("/api/cluster/git/guide-latest", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const projectId = queryString(request, "projectId");
    response.json(await latestFreshGuide(projectId, await reviewCwd(projectId, queryOptional(request, "taskId")), queryOptional(request, "conversationId") ?? null));
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/projects/:projectId/git/guide-latest", async (request, response, next) => {
  try {
    const conversationId = queryOptional(request, "conversationId");
    await withOwningNode(request, response, "/api/cluster/git/guide-latest", conversationId ? { conversationId } : {}, async () => {
      if (!await getProject(request.params.projectId)) throw new GitReviewError(404, "Project not found");
      return latestFreshGuide(request.params.projectId, await reviewCwd(request.params.projectId, queryOptional(request, "taskId")), conversationId ?? null);
    });
  } catch (error) { handleGitError(response, error, next); }
});

// ---- Change story ----

const storyRequest = z.object({
  conversationId: z.string().min(1).max(240).nullable(),
  source: z.enum(["conversation", "commits"]).default("conversation"),
  commits: z.array(z.string().regex(/^[0-9a-f]{7,40}$/i)).max(20).default([]),
  scope: z.enum(["conversation", "all"]),
  paths: z.array(z.string().min(1).max(2000)).max(100),
  includeCommits: z.boolean(),
  harnessId: gitReviewAskSchema.shape.harnessId,
  provider: z.string().max(200).optional(),
  modelId: z.string().min(1).max(300),
  thinkingLevel: gitReviewAskSchema.shape.thinkingLevel,
}).strict();

function storyThreadInfo(thread: GitReviewThread) {
  return { id: thread.id, harnessId: thread.harnessId, provider: thread.provider, modelId: thread.modelId, thinkingLevel: thread.thinkingLevel, createdAt: thread.createdAt, expiresAt: thread.expiresAt };
}

async function performStory(projectId: string, cwd: string, input: z.infer<typeof storyRequest>): Promise<unknown> {
  const project = await getProject(projectId);
  if (!project) throw new GitReviewError(404, "Project not found");
  let sources: StorySources;
  if (input.source === "commits") {
    if (!input.commits.length) throw new GitReviewError(400, "Pick at least one commit");
    sources = { kind: "commits", scope: "all", pendingPaths: [], includeCommits: false, commits: input.commits };
  } else {
    if (input.scope === "conversation" && !input.conversationId) throw new GitReviewError(400, "Conversation required");
    if (input.scope === "conversation" && input.paths.length) checkedConversationFiles(projectId, cwd, input.conversationId!, input.paths);
    const status = await gitStatus(cwd);
    const pending = new Set([...status.staged, ...status.unstaged, ...status.untracked].map(({ path }) => path));
    if (input.paths.some((file) => !pending.has(file))) throw new GitReviewError(409, "Selected files changed; refresh Git status");
    sources = { scope: input.scope, pendingPaths: input.paths, includeCommits: input.includeCommits && Boolean(input.conversationId) };
  }
  const { diff, ...saved } = await generateChangeStory({
    project, cwd, conversationId: input.conversationId, sources,
    harnessId: input.harnessId, provider: input.provider ?? "", modelId: input.modelId, thinkingLevel: input.thinkingLevel,
  });
  const thread = createGitReviewThread({ projectId, conversationId: input.conversationId, harnessId: input.harnessId, provider: input.provider ?? "", modelId: input.modelId, thinkingLevel: input.thinkingLevel, selection: { scope: "worktree" }, snapshot: diff, question: CHANGE_STORY_MARKER, answer: JSON.stringify(saved) });
  return { thread: storyThreadInfo(thread), saved, freshness: { fresh: true, newTurns: 0, changedPaths: [] } };
}

// The newest saved story for a conversation (or a chosen one), with its freshness and the
// commits the conversation has made so far.
async function latestStory(projectId: string, cwd: string, conversationId: string | null, threadId?: string): Promise<unknown> {
  const project = await getProject(projectId);
  if (!project) throw new GitReviewError(404, "Project not found");
  const commits = conversationId ? await conversationCommits(project, cwd, conversationId).catch(() => []) : [];
  const id = threadId ?? listGitReviewThreads(projectId, conversationId).find((thread) => thread.question === CHANGE_STORY_MARKER)?.id;
  const thread = id ? getGitReviewThread(id) : undefined;
  if (!thread || thread.projectId !== projectId || thread.messages[0]?.text !== CHANGE_STORY_MARKER) {
    if (threadId) throw new GitReviewError(404, "Story not found");
    return { latest: null, commits };
  }
  const saved = JSON.parse(thread.messages[1].text) as SavedChangeStory;
  return { latest: { thread: storyThreadInfo(thread), saved, freshness: await storyFreshness(project, cwd, thread.conversationId, saved) }, commits };
}

app.post("/api/cluster/git/story", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const projectId = queryString(request, "projectId");
    response.json(await performStory(projectId, await reviewCwd(projectId, queryOptional(request, "taskId")), storyRequest.parse(request.body)));
  } catch (error) { handleGitError(response, error, next); }
});

app.post("/api/projects/:projectId/git/story", async (request, response, next) => {
  try {
    await withOwningNode(request, response, "/api/cluster/git/story", {}, async () =>
      performStory(request.params.projectId, await reviewCwd(request.params.projectId, queryOptional(request, "taskId")), storyRequest.parse(request.body)), request);
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/cluster/git/pushes", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    response.json({ pushes: await gitPushHistory(await reviewCwd(queryString(request, "projectId"), queryOptional(request, "taskId"))) });
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/projects/:projectId/git/pushes", async (request, response, next) => {
  try {
    await withOwningNode(request, response, "/api/cluster/git/pushes", {}, async () =>
      ({ pushes: await gitPushHistory(await reviewCwd(request.params.projectId, queryOptional(request, "taskId"))) }));
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/cluster/git/story-latest", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const projectId = queryString(request, "projectId");
    response.json(await latestStory(projectId, await reviewCwd(projectId, queryOptional(request, "taskId")), queryOptional(request, "conversationId") ?? null, queryOptional(request, "threadId")));
  } catch (error) { handleGitError(response, error, next); }
});

app.get("/api/projects/:projectId/git/story-latest", async (request, response, next) => {
  try {
    const conversationId = queryOptional(request, "conversationId");
    const threadId = queryOptional(request, "threadId");
    await withOwningNode(request, response, "/api/cluster/git/story-latest", { conversationId, threadId }, async () =>
      latestStory(request.params.projectId, await reviewCwd(request.params.projectId, queryOptional(request, "taskId")), conversationId ?? null, threadId));
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
      const peer = await getRuntimePeer(nodeId);
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
      const peer = await getRuntimePeer(nodeId);
      if (!peer) { sendError(response, 404, "Git node not found"); return; }
      await proxyGitJson(response, peer, "/api/cluster/git/reviews/ask", { projectId, taskId, threadId: request.params.threadId }, request);
      return;
    }
    const payload = gitReviewFollowUpSchema.parse(request.body);
    const cwd = await reviewCwd(projectId, taskId);
    response.json(await performFollowUp(projectId, cwd, request.params.threadId, payload.question));
  } catch (error) { handleGitError(response, error, next); }
});
