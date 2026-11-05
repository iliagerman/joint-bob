import { existsSync } from "node:fs";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { getGuardianSettings, updateGuardianSettings } from "../../guardian/settings.js";
import { productionGuardStatus, withProductionGuard } from "../../guardian/production-rule.js";
import { allPendingGuardianReviews, decideGuardianReview } from "../../guardian/reviews.js";
import { projectVisible } from "../../store.js";
import { releaseLease, takeLease } from "../../control-center/leases.js";
import { requireAdmin } from "../admin.js";
import { broadcastToAllClients } from "../realtime.js";
import { sendError } from "../http-auth.js";
import { actingAccountFromSession } from "../../account-context.js";
import { bobDatabase, countBobMessages, rememberBobAccount } from "../../control-center/bob-store.js";
import { overviewConversations } from "../../control-center/overview.js";
import { bobStartedKeys } from "../../control-center/started.js";
import { storedDigest } from "../../conversation-digest.js";
import { gitCommitHistory, gitStatus } from "../../git-review.js";
import { knowledgeDirectory, readSubjects } from "../../project-knowledge.js";
import { projectsWithSharedNames } from "../projects.js";
import { sharedProjectSessions } from "../sessions-helpers.js";
import { startMemorySync } from "../../control-center/memory-sync.js";
import { loadBoard } from "../control-center-board.js";
import { startControlCenterWatch } from "../control-center-watch.js";
import { app } from "../state.js";

/** What the control center board shows: running conversations and finished ones waiting for review, across every project the caller can see. */
startControlCenterWatch();
startMemorySync();

/** What waits for the person, for the badge on the control center's icon: open Guardian reviews and Bob's items with buttons still on them. */
app.get("/api/control-center/summary", async (_request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const reviews = allPendingGuardianReviews();
    const visible = (await Promise.all(reviews.map((review) => projectVisible(review.projectId)))).filter(Boolean).length;
    response.json({ waiting: visible + countBobMessages(await bobDatabase(), session.accountId, "important") });
  } catch (error) { next(error); }
});

app.get("/api/control-center/board", async (_request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    // Opening the control center is how Bob learns who to tell about things that happen later.
    rememberBobAccount(await bobDatabase(), actingAccountFromSession(session));
    const { cards, projects } = await loadBoard(session);
    response.json({ cards, projects: projects.map((project) => ({ id: project.id, name: project.name })) });
  } catch (error) {
    next(error);
  }
});

const decisionSchema = z.object({
  projectId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  reviewId: z.string().min(1).max(100),
  decision: z.enum(["allow", "block"]),
}).strict();

/** The person's answer to a Guardian review, from the board. Only a project they can see can be answered. */
app.post("/api/control-center/guardian/decide", async (request, response, next) => {
  try {
    const input = decisionSchema.parse(request.body);
    if (!await projectVisible(input.projectId) || !decideGuardianReview(input.projectId, input.conversationId, input.reviewId, input.decision)) {
      sendError(response, 404, "That review was already answered, or it timed out and was blocked");
      return;
    }
    response.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid answer"); return; }
    next(error);
  }
});

/** Whether production and destructive steps ask first on this machine. */
app.get("/api/control-center/guardian", (_request, response) => {
  response.json({ status: productionGuardStatus(getGuardianSettings()) });
});

/** Turns Guardian on with the production rule. Guardian is a machine setting, so only an administrator can. */
app.post("/api/control-center/guardian/protect", requireAdmin, (_request, response) => {
  response.json({ status: productionGuardStatus(updateGuardianSettings(withProductionGuard(getGuardianSettings()))) });
});

const leaseSchema = z.object({
  projectId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  action: z.enum(["take", "release"]),
}).strict();

/**
 * Taking control of a conversation keeps Bob and auto respond out of it until it is given back. The page renews it while
 * the person stays in the conversation; a closed page lets it lapse after a minute.
 */
app.post("/api/control-center/lease", async (request, response, next) => {
  try {
    const input = leaseSchema.parse(request.body);
    const session = response.locals.authSession as AuthSession;
    if (!await projectVisible(input.projectId)) { sendError(response, 404, "Project not found"); return; }
    if (input.action === "release") {
      releaseLease(input.projectId, input.conversationId, session.accountId);
      broadcastToAllClients({ type: "controlCenterChanged" });
      response.json({ leased: false });
      return;
    }
    if (!takeLease(input.projectId, input.conversationId, session.accountId)) { sendError(response, 409, "Someone else is in control of this conversation"); return; }
    broadcastToAllClients({ type: "controlCenterChanged" });
    response.json({ leased: true });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request"); return; }
    next(error);
  }
});

/** One project at a glance: its conversations as headlines, what changed recently, and what its knowledge holds. */
app.get("/api/control-center/overview", async (request, response, next) => {
  try {
    const { project: projectId } = z.object({ project: z.string().min(1).max(200) }).strict().parse(request.query);
    const session = response.locals.authSession as AuthSession;
    const project = (await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false })).find((candidate) => candidate.id === projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const [sessions, started] = await Promise.all([sharedProjectSessions(project, session.userId, session.accountId), bobStartedKeys()]);
    const conversations = overviewConversations(sessions, {
      summaryOf: (conversationId) => storedDigest(project.id, conversationId)?.summary ?? null,
      startedByBob: (sessionId, conversationId) => started.has(`${project.id}:${sessionId}`) || started.has(`${project.id}:${conversationId}`),
    });
    // A project that is not a git repository simply has no changes to show.
    const changes = await gitStatus(project.path).then(async (status) => ({
      branch: status.branch, ahead: status.ahead, behind: status.behind, uncommitted: status.staged.length + status.unstaged.length + status.untracked.length,
      commits: (await gitCommitHistory(project.path, 6)).map((commit) => ({ shortHash: commit.shortHash, subject: commit.subject, date: commit.date, author: commit.author })),
    }), () => null);
    const knowledge = existsSync(knowledgeDirectory(project.path)) ? readSubjects(project.path).map((subject) => ({ slug: subject.slug, description: subject.description, rules: subject.rules.length })) : [];
    response.json({ project: { id: project.id, name: project.name }, conversations, changes, knowledge });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid project"); return; }
    next(error);
  }
});
