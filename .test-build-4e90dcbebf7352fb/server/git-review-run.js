import { internalSessionId } from "../internal-sessions.js";
import { getHarness, getHarnessRuntime } from "../harnesses.js";
class GitReviewRunError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
}
const REVIEW_TURN_TIMEOUT_MS = 5 * 6e4;
const REVIEW_ANSWER_LIMIT = 4e4;
const REVIEW_DIFF_LIMIT = 12e4;
function boundedDiff(diff) {
  if (diff.length <= REVIEW_DIFF_LIMIT) return diff;
  return `${diff.slice(0, REVIEW_DIFF_LIMIT)}
\u2026 diff truncated for review`;
}
function reviewPrompt(input) {
  if (input.instructions) return `${input.instructions}

${boundedDiff(input.diff)}`;
  const target = input.selection.scope === "commit" ? `commit ${input.selection.revision}` : input.selection.filePath ? `the ${input.selection.staged ? "staged" : "working-tree"} change to ${input.selection.filePath}` : "the current working-tree changes";
  const historyBlock = input.history?.length ? `

Earlier in this review:
${input.history.map((entry) => `${entry.role === "user" ? "Question" : "Explanation"}: ${entry.text}`).join("\n\n")}` : "";
  return [
    "You are a read-only code reviewer. Explain code changes; never modify files, run mutating commands, stage, commit, or push.",
    "Use only the provided diff and conversation context. Cite file paths and line references where useful.",
    `The user is asking about ${target}.`,
    "",
    "```diff",
    boundedDiff(input.diff),
    "```",
    historyBlock,
    "",
    `Question: ${input.question}`
  ].join("\n");
}
async function restrictToReadOnly(session) {
  await session.setTools([]);
}
function collectAnswer(events) {
  const text = events.filter((event) => event.type === "textDelta" && typeof event.text === "string").map((event) => event.text).join("");
  return text.trim().slice(0, REVIEW_ANSWER_LIMIT);
}
async function runGitReview(input) {
  const adapter = getHarness(input.harnessId);
  if (!adapter.runtime) throw new GitReviewRunError(400, `${adapter.label} cannot run reviews`);
  const runtime = await getHarnessRuntime(input.harnessId);
  const session = await runtime.open({ projectId: input.projectId, cwd: input.cwd, sessionId: internalSessionId() });
  const events = [];
  let soFar = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start") {
      events.length = 0;
      soFar = "";
    }
    if (event.type === "textDelta" && typeof event.text === "string") {
      events.push(event);
      soFar += event.text;
      input.onText?.(soFar);
    }
  });
  try {
    const base = session.settings();
    const settings = {
      ...base,
      provider: input.provider || base.provider,
      modelId: input.modelId || base.modelId,
      reasoning: input.thinkingLevel || base.reasoning
    };
    await runtime.validateSettings(settings);
    await session.configure(settings);
    await session.preflight();
    await restrictToReadOnly(session);
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void session.cancel().catch(() => {
        });
        reject(new GitReviewRunError(504, "Review timed out"));
      }, REVIEW_TURN_TIMEOUT_MS);
      timer.unref();
      const stop = session.subscribe((event) => {
        if (event.type === "agent_end") {
          clearTimeout(timer);
          stop();
          resolve();
        }
        if (event.type === "error") {
          clearTimeout(timer);
          stop();
          reject(new GitReviewRunError(502, typeof event.error === "string" ? event.error : "Review failed"));
        }
      });
    });
    await session.prompt({ text: reviewPrompt(input) });
    await done;
    const answer = collectAnswer(events);
    if (!answer) throw new GitReviewRunError(502, "Review produced no explanation");
    const status = session.status();
    return {
      answer,
      provider: status.model?.provider ?? settings.provider,
      modelId: status.model?.id ?? settings.modelId,
      thinkingLevel: status.thinkingLevel ?? settings.reasoning
    };
  } catch (error) {
    if (error instanceof GitReviewRunError) throw error;
    throw new GitReviewRunError(502, error instanceof Error ? error.message : "Review failed");
  } finally {
    unsubscribe();
    try {
      if (session.isBusy()) await session.cancel();
    } catch {
    }
    session.dispose();
  }
}
export {
  GitReviewRunError,
  runGitReview
};
