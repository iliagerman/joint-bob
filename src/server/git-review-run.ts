import { randomUUID } from "node:crypto";
import { getHarness, getHarnessRuntime } from "../harnesses.js";
import type { HarnessEvent, HarnessModelSettings, HarnessSession } from "../harnesses/runtime.js";
import type { GitReviewSelection } from "../git-review-threads.js";
import type { HarnessId } from "../types.js";

export class GitReviewRunError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// A review turn is explanation-only; it must never run for a very long time. If the
// model has not finished within this window, the run is cancelled and reported.
const REVIEW_TURN_TIMEOUT_MS = 5 * 60_000;
const REVIEW_ANSWER_LIMIT = 40_000;
// The diff handed to the model is bounded so a huge change cannot blow the context.
const REVIEW_DIFF_LIMIT = 120_000;

// Tool names, across harnesses, that only read state. The review agent is restricted
// to these so an explanation cannot silently mutate the working tree. Enforcement is
// best-effort per harness: a harness that advertises no matching tool runs with tools
// disabled entirely, and the prompt reinforces the read-only contract regardless.
const READ_ONLY_TOOL_PATTERN = /^(fs_read|read|read_file|grep|search|search_files|list|list_directory|glob|find|codebase|get_document_symbols|lookup_symbols|search_symbols)$/i;

export interface RunGitReviewInput {
  projectId: string;
  cwd: string;
  harnessId: HarnessId;
  provider: string;
  modelId: string;
  thinkingLevel: string;
  selection: GitReviewSelection;
  diff: string;
  question: string;
  /** Prior exchanges in this thread, oldest first, replayed as context. */
  history?: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface RunGitReviewResult {
  answer: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

function boundedDiff(diff: string): string {
  if (diff.length <= REVIEW_DIFF_LIMIT) return diff;
  return `${diff.slice(0, REVIEW_DIFF_LIMIT)}\n… diff truncated for review`;
}

function reviewPrompt(input: RunGitReviewInput): string {
  const target = input.selection.scope === "commit"
    ? `commit ${input.selection.revision}`
    : input.selection.filePath
      ? `the ${input.selection.staged ? "staged" : "working-tree"} change to ${input.selection.filePath}`
      : "the current working-tree changes";
  const historyBlock = input.history?.length
    ? `\n\nEarlier in this review:\n${input.history.map((entry) => `${entry.role === "user" ? "Question" : "Explanation"}: ${entry.text}`).join("\n\n")}`
    : "";
  return [
    "You are a read-only code reviewer. Explain code changes; never modify files, run mutating commands, stage, commit, or push.",
    "You may read and search the project to understand context, then answer in prose. Cite file paths and line references where useful.",
    `The user is asking about ${target}.`,
    "",
    "```diff",
    boundedDiff(input.diff),
    "```",
    historyBlock,
    "",
    `Question: ${input.question}`,
  ].join("\n");
}

/** Restricts the session to read-only tools when the harness advertises any; otherwise disables all. */
async function restrictToReadOnly(session: HarnessSession): Promise<void> {
  try {
    const readOnly = session.tools().filter((tool) => READ_ONLY_TOOL_PATTERN.test(tool.name)).map((tool) => tool.name);
    await session.setTools(readOnly);
  } catch {
    // A harness that cannot restrict tools still runs; the prompt states the read-only
    // contract, and this is explanation-only work with a short, cancelled-on-timeout turn.
  }
}

function collectAnswer(events: HarnessEvent[]): string {
  const text = events
    .filter((event) => event.type === "textDelta" && typeof event.text === "string")
    .map((event) => event.text as string)
    .join("");
  return text.trim().slice(0, REVIEW_ANSWER_LIMIT);
}

/**
 * Runs one explanation-only review turn in an isolated, throwaway harness session and
 * returns the model's answer. The session is disposed before returning, so it never joins
 * the project's live conversations.
 */
export async function runGitReview(input: RunGitReviewInput): Promise<RunGitReviewResult> {
  const adapter = getHarness(input.harnessId);
  if (!adapter.runtime) throw new GitReviewRunError(400, `${adapter.label} cannot run reviews`);
  const runtime = await getHarnessRuntime(input.harnessId);
  const sessionId = randomUUID();
  const session = await runtime.open({ projectId: input.projectId, cwd: input.cwd, sessionId });
  const events: HarnessEvent[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start") events.length = 0;
    if (event.type === "textDelta" && typeof event.text === "string") events.push(event);
  });
  try {
    const base = session.settings();
    const settings: HarnessModelSettings = {
      ...base,
      provider: input.provider || base.provider,
      modelId: input.modelId || base.modelId,
      reasoning: input.thinkingLevel || base.reasoning,
    };
    await runtime.validateSettings(settings);
    await session.configure(settings);
    await session.preflight();
    await restrictToReadOnly(session);

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void session.cancel().catch(() => {});
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
      thinkingLevel: status.thinkingLevel ?? settings.reasoning,
    };
  } catch (error) {
    if (error instanceof GitReviewRunError) throw error;
    throw new GitReviewRunError(502, error instanceof Error ? error.message : "Review failed");
  } finally {
    unsubscribe();
    try {
      if (session.isBusy()) await session.cancel();
    } catch {
      // Best effort: the session is being torn down regardless.
    }
    session.dispose();
  }
}
