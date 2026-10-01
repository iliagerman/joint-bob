import { createHash } from "node:crypto";
import { z } from "zod";
import { getHarness, listHarnessSessions } from "../harnesses.js";
import { listConversationSegments } from "../conversation-records.js";
import { runGitReview } from "./git-review-run.js";
import { gitFileDiff, gitStatus, GitReviewError, type GitFileChange } from "../git-review.js";
import type { ProjectRecord } from "../types.js";

const guideSchema = z.object({
  summary: z.string().min(1).max(2000),
  items: z.array(z.object({ path: z.string(), priority: z.enum(["high", "medium", "low"]), title: z.string().min(1).max(200), explanation: z.string().min(1).max(2000), checks: z.string().max(1000) }).strict()).min(1).max(100),
}).strict();
export type GitReviewGuide = z.infer<typeof guideSchema>;

function parseJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
}

export async function conversationReviewContext(project: ProjectRecord, conversationId: string): Promise<{ transcript: string; lastHarness: string }> {
  const sessions = await listHarnessSessions(project);
  const session = sessions.find((item) => (item.conversationId ?? item.id) === conversationId);
  if (!session) throw new Error("Conversation not found in this project");
  const records = await listConversationSegments(project.id, conversationId);
  const entries = records.length ? records.map((record) => ({ engine: record.engine, path: session.segments?.find((segment) => segment.engine === record.engine && segment.sessionId === record.sessionId)?.path ?? (session.harnessId === record.engine && session.id === record.sessionId ? session.path : "") })) : [{ engine: session.harnessId, path: session.path }];
  const messages = [];
  let lastHarness = session.harnessId;
  for (const entry of entries) {
    if (!entry.path) continue;
    const loaded = await getHarness(entry.engine).sessions.loadMessages(project, entry.path);
    for (const message of loaded) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      messages.push(`${message.role === "assistant" ? "Assistant" : "User"} (${entry.engine}): ${message.text.slice(0, 2500)}`);
      if (message.role === "assistant") lastHarness = message.attribution?.harnessId ?? entry.engine;
    }
  }
  if (!messages.length) throw new Error("Conversation has no transcript to determine changed files");
  return { transcript: messages.join("\n\n").slice(-45_000), lastHarness };
}

// The agent's answer is reused while the transcript and pending paths are unchanged.
const discoveries = new Map<string, { paths: string[]; lastHarness: string; fingerprint: string; expires: number }>();

export function checkedConversationFiles(projectId: string, cwd: string, conversationId: string, paths: string[]): void {
  const saved = discoveries.get(JSON.stringify([projectId, cwd, conversationId]));
  if (!saved || saved.expires < Date.now() || paths.some((file) => !saved.paths.includes(file))) throw new GitReviewError(409, "Conversation file list expired; refresh it before reviewing");
}

export async function discoverConversationFiles(project: ProjectRecord, cwd: string, conversationId: string, refresh = false): Promise<{ paths: string[]; lastHarness: string }> {
  const { transcript, lastHarness } = await conversationReviewContext(project, conversationId);
  const status = await gitStatus(cwd);
  const pending = [...status.staged, ...status.unstaged, ...status.untracked];
  const candidatePaths = [...new Set(pending.map(({ path }) => path))];
  const key = JSON.stringify([project.id, cwd, conversationId]);
  const fingerprint = createHash("sha256").update(JSON.stringify([candidatePaths, transcript])).digest("hex");
  const saved = discoveries.get(key);
  if (!refresh && saved?.fingerprint === fingerprint) {
    saved.expires = Date.now() + 10 * 60_000;
    return { paths: saved.paths, lastHarness: saved.lastHarness };
  }
  if (!pending.length) {
    discoveries.set(key, { paths: [], lastHarness, fingerprint, expires: Date.now() + 10 * 60_000 });
    return { paths: [], lastHarness };
  }
  if (JSON.stringify(candidatePaths).length + transcript.length > 110_000) throw new GitReviewError(413, "Too many pending paths to identify safely");
  const result = await runGitReview({
    projectId: project.id, cwd, harnessId: lastHarness, provider: "", modelId: "", thinkingLevel: "",
    selection: { scope: "worktree" }, question: "", diff: `Pending Git paths:\n${JSON.stringify(candidatePaths)}\n\nConversation transcript (recent excerpt):\n${transcript}`,
    instructions: "Read ONLY the supplied conversation transcript. Which pending paths did the coding agent say it changed for this conversation? Return a JSON array of exact paths from the pending list. If unsure, omit the path. Do not infer ownership from filenames. No prose or code fences.",
  });
  const claimed = z.array(z.string().max(2000)).max(500).parse(parseJson(result.answer));
  const allowed = new Set(candidatePaths);
  const paths = [...new Set(claimed.filter((file) => allowed.has(file)))];
  discoveries.set(key, { paths, lastHarness, fingerprint, expires: Date.now() + 10 * 60_000 });
  return { paths, lastHarness };
}

export async function pendingReviewDiff(cwd: string, paths: string[]): Promise<{ diff: string; fingerprint: string; changes: GitFileChange[]; patches: Record<string, string> }> {
  const status = await gitStatus(cwd);
  const selected = new Set(paths);
  const changes = [...status.staged, ...status.unstaged, ...status.untracked].filter(({ path }) => selected.has(path));
  const patches: string[] = [];
  const byPath: Record<string, string> = {};
  let diffLength = 0;
  for (const change of changes) {
    const result = await gitFileDiff(cwd, change.path, { staged: change.staged, untracked: change.kind === "untracked" });
    if (result.truncated) throw new GitReviewError(413, `Diff too large to review completely: ${change.path}`);
    diffLength += result.patch.length;
    if (diffLength > 95_000) throw new GitReviewError(413, "Selected diff exceeds the review limit; choose fewer files");
    patches.push(result.patch);
    byPath[change.path] = [byPath[change.path], result.patch].filter(Boolean).join("\n");
  }
  const diff = patches.join("\n");
  return { diff, fingerprint: createHash("sha256").update(diff).digest("hex"), changes, patches: byPath };
}

export interface GenerateReviewGuideInput {
  projectId: string;
  cwd: string;
  paths: string[];
  transcript: string;
  lastHarness: string;
  harnessId: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export async function generateReviewGuide(input: GenerateReviewGuideInput): Promise<{ guide: GitReviewGuide; diff: string; fingerprint: string; patches: Record<string, string> }> {
  const { projectId, cwd, paths, transcript, lastHarness, harnessId, provider, modelId, thinkingLevel } = input;
  const { diff, fingerprint, changes, patches } = await pendingReviewDiff(cwd, paths);
  if (!changes.length) throw new Error("No pending files in the selected scope");
  if (!diff.trim() || diff.length > 95_000) throw new Error("Selected diff is empty or too large for a complete review");
  const names = [...new Set(changes.map(({ path }) => path))];
  if (JSON.stringify(names).length + transcript.slice(-18_000).length + diff.length > 110_000) throw new GitReviewError(413, "Selected review exceeds the model input limit; choose fewer files");
  const result = await runGitReview({
    projectId, cwd, harnessId, provider, modelId, thinkingLevel,
    selection: { scope: "worktree" }, question: "", diff: `Allowed paths: ${JSON.stringify(names)}\nCoding conversation (recent excerpt, last harness ${lastHarness}):\n${transcript.slice(-18_000)}\n\nPending diff:\n${diff}`,
    instructions: "Review the pending changes only. Return ONLY JSON: {\"summary\":string,\"items\":[{\"path\":string,\"priority\":\"high\"|\"medium\"|\"low\",\"title\":string,\"explanation\":string,\"checks\":string}]}. Order items by risk first and then by implementation story. Cover every allowed path exactly once. Explain what changed, why it matters, and what to verify. Never claim a bug without evidence. Do not edit files.",
  });
  const guide = guideSchema.parse(parseJson(result.answer));
  if (guide.items.length !== names.length || new Set(guide.items.map(({ path }) => path)).size !== names.length || guide.items.some(({ path }) => !names.includes(path))) throw new Error("Review did not cover every selected file; try a smaller scope");
  const priority = { high: 0, medium: 1, low: 2 };
  guide.items.sort((left, right) => priority[left.priority] - priority[right.priority]);
  return { guide, diff, fingerprint, patches };
}
