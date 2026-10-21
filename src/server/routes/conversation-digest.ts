import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { answeredTurns, type ConversationDigest, type DigestModel, digestIsStale, digestMaterial, digestPrompt, parseDigestAnswer, saveDigest, storedDigest, turnsToSummarize } from "../../conversation-digest.js";
import { listDiscoveredHarnesses } from "../../harnesses/registry.js";
import { getUserPreferences } from "../../preferences.js";
import { getSettings } from "../../settings.js";
import { getProject, projectVisible } from "../../store.js";
import type { ChatMessage, HarnessId, ProjectRecord } from "../../types.js";
import { buildTurns, loadConversationMessages } from "../conversation-turns.js";
import { GitReviewRunError, runGitReview } from "../git-review-run.js";
import { sendError } from "../http-auth.js";
import { iconHarnessId } from "../label-icon.js";
import { registeredHarnessIdSchema } from "../schemas.js";
import { listReviewScopeSessions } from "../sessions-helpers.js";
import { app } from "../state.js";

class DigestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// One refresh per conversation at a time: a second page asking meanwhile shares it.
const running = new Map<string, Promise<ConversationDigest>>();

// The agent and model the open conversation is using, as the page sees them.
const digestRequestSchema = z.object({
  conversation: z.object({
    harnessId: registeredHarnessIdSchema,
    provider: z.string().trim().max(200).optional(),
    modelId: z.string().trim().max(300).optional(),
  }).strict().optional(),
}).strict();
type ConversationModel = NonNullable<z.infer<typeof digestRequestSchema>["conversation"]>;

interface SummaryRun extends DigestModel { thinkingLevel: string }

function canRunHere(harnessId: string): boolean {
  return listDiscoveredHarnesses().some((adapter) => adapter.id === harnessId && adapter.runtime && getSettings().conversationDefaults[adapter.id]);
}

/** The newest assistant answer that recorded which agent and model wrote it. */
function lastAttribution(messages: ChatMessage[]): ConversationModel | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const attribution = messages[index].role === "assistant" ? messages[index].attribution : undefined;
    if (attribution) return { harnessId: attribution.harnessId, provider: attribution.provider, modelId: attribution.modelId };
  }
  return undefined;
}

/**
 * Who writes the summary: the person's Summary model setting when they chose one, otherwise
 * the conversation's own agent and model (as the page reports it, else as the transcript last
 * recorded it) at that agent's default effort. A conversation whose agent cannot run on this
 * machine falls back to the first agent that can; a chosen setting that cannot is an error.
 */
export function summaryRun(setting: { harnessId: HarnessId; provider?: string; modelId: string; thinkingLevel: string } | null, conversation: ConversationModel | undefined, messages: ChatMessage[], lastHarness: string): SummaryRun {
  if (setting) {
    if (!canRunHere(setting.harnessId)) throw new DigestError(400, `${setting.harnessId} cannot run on this machine; choose another summary model in Settings → Conversations`);
    return { harnessId: setting.harnessId, provider: setting.provider ?? "", modelId: setting.modelId, thinkingLevel: setting.thinkingLevel, source: "setting" };
  }
  const own = conversation ?? lastAttribution(messages) ?? { harnessId: lastHarness as HarnessId };
  if (canRunHere(own.harnessId)) return { harnessId: own.harnessId, provider: own.provider ?? "", modelId: own.modelId ?? "", thinkingLevel: "", source: "conversation" };
  return { harnessId: iconHarnessId() as HarnessId, provider: "", modelId: "", thinkingLevel: "", source: "fallback" };
}

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

async function conversationTranscript(project: ProjectRecord, conversationId: string) {
  try {
    const { messages, lastHarness } = await loadConversationMessages(project, conversationId);
    // A prompt still waiting for its first answer has nothing to summarize yet.
    return { messages, lastHarness, turns: answeredTurns(buildTurns(messages)) };
  } catch (error) {
    throw new DigestError(404, error instanceof Error ? error.message : "Conversation not found");
  }
}

async function refreshDigest(project: ProjectRecord, conversationId: string, userId: string, conversation: ConversationModel | undefined): Promise<ConversationDigest> {
  const { messages, lastHarness, turns } = await conversationTranscript(project, conversationId);
  const previous = storedDigest(project.id, conversationId);
  if (!digestIsStale(previous, turns)) {
    if (previous) return previous;
    throw new DigestError(409, "Nothing to summarize yet");
  }
  const pending = turnsToSummarize(previous, turns);
  const run = summaryRun(getUserPreferences(userId).summaryModel, conversation, messages, lastHarness);
  const override = process.env.JOINT_BOB_DIGEST_GENERATOR;
  const instructions = digestPrompt(previous?.summary);
  const material = digestMaterial(pending.from, pending.turns);
  let answer: string;
  const model: DigestModel = { harnessId: run.harnessId, provider: run.provider, modelId: run.modelId, source: run.source };
  if (override) {
    answer = await (await import(override) as { default: (input: { instructions: string; material: string; run: SummaryRun }) => Promise<string> }).default({ instructions, material, run });
  } else {
    const result = await runGitReview({
      // The home folder, not the project: project instruction files have no place in a summary.
      projectId: project.id, cwd: getSettings().projects.homePath, harnessId: run.harnessId, provider: run.provider, modelId: run.modelId, thinkingLevel: run.thinkingLevel,
      selection: { scope: "context", label: "conversation turns" }, question: "", diff: material, instructions,
    });
    answer = result.answer;
    model.provider = result.provider;
    model.modelId = result.modelId;
  }
  const summary = parseDigestAnswer(answer);
  if (!summary) throw new DigestError(502, "The agent returned an empty summary; try again");
  const digest: ConversationDigest = { summary, turns: turns.length, lastAnswerLength: turns.at(-1)?.assistant.length ?? 0, updatedAt: new Date().toISOString(), model };
  saveDigest(project.id, conversationId, digest);
  return digest;
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
    // A conversation that has not started has nothing to summarize yet; that is not an error.
    if (!await conversationListed(project, conversationId, response.locals.authSession as AuthSession)) {
      response.json({ digest: null, stale: false, turns: 0, refreshing: false });
      return;
    }
    const digest = storedDigest(project.id, conversationId) ?? null;
    let turns;
    try {
      ({ turns } = await conversationTranscript(project, conversationId));
    } catch (error) {
      // Listed but not readable here, such as a transcript still arriving from another node.
      if (!(error instanceof DigestError)) throw error;
      response.json({ digest, stale: false, turns: digest?.turns ?? 0, unavailable: true, refreshing: false });
      return;
    }
    response.json({ digest, stale: digestIsStale(digest ?? undefined, turns), turns: turns.length, refreshing: running.has(`${project.id}:${conversationId}`) });
  } catch (error) {
    if (!sendDigestError(response, error)) next(error);
  }
});

/**
 * Brings the summary up to date with the transcript, reading only the turns it has not seen.
 * The model failing to write one is reported in the body with the summary that is still
 * stored, like a change story's error line: the request itself was fine.
 */
app.post("/api/projects/:projectId/conversations/:conversationId/digest", async (request, response, next) => {
  try {
    const { projectId, conversationId } = request.params;
    const project = await visibleProject(projectId);
    const authSession = response.locals.authSession as AuthSession;
    const { conversation } = digestRequestSchema.parse(request.body ?? {});
    if (!await conversationListed(project, conversationId, authSession)) throw new DigestError(404, "Conversation not found");
    const key = `${project.id}:${conversationId}`;
    let job = running.get(key);
    if (!job) {
      job = refreshDigest(project, conversationId, authSession.userId, conversation).finally(() => running.delete(key));
      running.set(key, job);
    }
    try {
      response.json({ digest: await job, stale: false });
    } catch (error) {
      if (!(error instanceof DigestError) && !(error instanceof GitReviewRunError)) console.warn("Conversation summary failed", error);
      response.json({ digest: storedDigest(project.id, conversationId) ?? null, stale: true, error: error instanceof Error ? error.message : "The summary could not be written" });
    }
  } catch (error) {
    if (!sendDigestError(response, error)) next(error);
  }
});
