import { createHash } from "node:crypto";
import { z } from "zod";
import { gitCommitDetail, gitCommitFileDiff, GitReviewError, type GitChangeKind } from "../git-review.js";
import type { HarnessId, ProjectRecord } from "../types.js";
import { buildTurns, loadConversationMessages, type ConversationTurn } from "./conversation-turns.js";
import { pendingReviewDiff } from "./git-review-guide.js";
import { runGitReview } from "./git-review-run.js";

/** The question text that marks a review thread as a saved change story. */
export const CHANGE_STORY_MARKER = "Generated change story";

const STORY_DIFF_LIMIT = 90_000;
const STORY_INPUT_LIMIT = 115_000;
const DIGEST_LIMIT = 24_000;
const COMMIT_LIMIT = 20;

const words = (max: number) => z.string().trim().min(1).max(max);
const optionalWords = (max: number) => z.string().trim().max(max).default("");
const NODE_KINDS = ["action", "decision", "process", "model", "store", "source", "error"] as const;

const storySchema = z.object({
  kind: z.enum(["Feature", "Fix", "Refactor", "Tests", "Docs", "Chore"]),
  title: words(120),
  overview: z.object({
    what: words(500),
    why: words(600),
    notice: z.array(words(240)).min(1).max(6),
    unchanged: optionalWords(300),
  }),
  diagram: z.object({
    lanes: z.array(z.object({ id: words(40), label: words(30) })).min(1).max(6),
    nodes: z.array(z.object({
      id: words(40), lane: words(40), kind: z.enum(NODE_KINDS), label: words(28), sub: optionalWords(28),
      text: words(500), files: z.array(z.string().max(2000)).max(12).default([]),
    })).min(2).max(14),
    edges: z.array(z.object({
      from: words(40), to: words(40), label: optionalWords(16), style: z.enum(["solid", "dashed", "bad"]).default("solid"),
    })).min(1).max(28),
  }),
  timeline: z.array(z.object({
    turns: z.array(z.number().int().min(1)).min(1).max(60),
    title: words(90),
    did: z.array(words(300)).min(1).max(5),
    decided: z.array(words(300)).max(4).default([]),
    pivot: optionalWords(320),
    quiet: z.boolean().default(false),
  })).max(30),
  examples: z.array(z.object({
    kind: z.enum(["Happy path", "Edge case", "Failure", "Navigation"]),
    title: words(90),
    start: words(320),
    steps: z.array(z.object({
      you: optionalWords(240), app: words(320), says: optionalWords(240),
      nodes: z.array(z.string().max(40)).max(14).default([]), edges: z.array(z.string().max(90)).max(20).default([]),
    })).min(1).max(6),
    result: words(320),
  })).min(1).max(8),
  implementation: z.object({
    what: z.record(z.string(), words(240)).default({}),
    decisions: z.array(z.object({ title: words(110), why: words(320), instead: words(240), turn: z.number().int().min(1).nullable().default(null) })).max(8).default([]),
    checks: z.array(z.object({ priority: z.enum(["high", "medium", "low"]), text: words(260), file: optionalWords(2000) })).max(10).default([]),
    tests: z.array(z.object({ file: words(2000), name: words(180) })).max(20).default([]),
  }),
});
export type ChangeStory = z.infer<typeof storySchema>;

export interface StoryFile { path: string; kind: "added" | "modified" | "deleted" | "renamed"; add: number; del: number; where: string[]; area: string }
export interface StoryTurn { n: number; at?: string; user: string; commits: string[]; paths: string[] }
export interface StoryCommit { hash: string; shortHash: string; subject: string; turn: number }
export interface StoryPatch { path: string; source: string; patch: string }
export interface StoryFacts { conversation: boolean; turns: StoryTurn[]; commits: StoryCommit[]; files: StoryFile[] }
export interface StorySources { scope: "conversation" | "all"; pendingPaths: string[]; includeCommits: boolean }
export interface SavedChangeStory {
  story: ChangeStory;
  facts: StoryFacts;
  patches: StoryPatch[];
  fingerprint: string;
  sources: StorySources;
  generatedAt: string;
}

function parseJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
}

export function lineCounts(patch: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) del += 1;
  }
  return { add, del };
}

/** Files group by their first two directories, so `src/server/x.ts` sits under `src/server`. */
export function fileArea(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return "root";
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

/** Throws a 422 naming the first reference the story makes to something that does not exist. */
export function checkStory(story: ChangeStory, facts: { paths: string[]; turns: number }): void {
  const fail = (reason: string): never => { throw new GitReviewError(422, `Story rejected. ${reason}`); };
  const paths = new Set(facts.paths);
  const knownPath = (path: string, where: string) => { if (!paths.has(path)) fail(`It mentions ${path} in ${where}, which is not part of these changes.`); };
  const knownTurn = (turn: number, where: string) => { if (turn > facts.turns) fail(`${where} cites turn ${turn}, but the conversation has ${facts.turns} turn${facts.turns === 1 ? "" : "s"}.`); };
  const lanes = new Set<string>();
  for (const lane of story.diagram.lanes) { if (lanes.has(lane.id)) fail(`The diagram repeats the lane "${lane.id}".`); lanes.add(lane.id); }
  const nodes = new Map<string, string>();
  for (const node of story.diagram.nodes) {
    if (nodes.has(node.id)) fail(`The diagram repeats the step id "${node.id}".`);
    if (!lanes.has(node.lane)) fail(`The diagram step "${node.label}" sits in a lane that does not exist.`);
    nodes.set(node.id, node.label);
    for (const path of node.files) knownPath(path, `the diagram step "${node.label}"`);
  }
  const edges = new Set<string>();
  for (const edge of story.diagram.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) fail(`A diagram arrow points at a step that does not exist (${edge.from} to ${edge.to}).`);
    if (edge.from === edge.to) fail(`The diagram step "${nodes.get(edge.from)}" points at itself.`);
    edges.add(`${edge.from}>${edge.to}`);
  }
  // The layout reads arrows left to right, so a loop has no place to go.
  const indegree = new Map([...nodes.keys()].map((id) => [id, 0]));
  for (const edge of story.diagram.edges) indegree.set(edge.to, indegree.get(edge.to)! + 1);
  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen += 1;
    for (const edge of story.diagram.edges.filter((item) => item.from === id)) {
      indegree.set(edge.to, indegree.get(edge.to)! - 1);
      if (indegree.get(edge.to) === 0) queue.push(edge.to);
    }
  }
  if (seen !== nodes.size) fail("The diagram contains a loop.");
  if (!facts.turns && story.timeline.length) fail("It describes conversation turns, but this story has no conversation.");
  for (const phase of story.timeline) for (const turn of phase.turns) knownTurn(turn, `The step "${phase.title}"`);
  for (const example of story.examples) {
    for (const step of example.steps) {
      for (const id of step.nodes) if (!nodes.has(id)) fail(`The example "${example.title}" points at a diagram step that does not exist (${id}).`);
      for (const id of step.edges) if (!edges.has(id)) fail(`The example "${example.title}" points at a diagram arrow that does not exist (${id}).`);
    }
  }
  for (const path of Object.keys(story.implementation.what)) knownPath(path, "Implementation, Components");
  for (const check of story.implementation.checks) if (check.file) knownPath(check.file, "What to check");
  for (const item of story.implementation.tests) knownPath(item.file, "Tests");
  for (const decision of story.implementation.decisions) if (decision.turn !== null) knownTurn(decision.turn, `The decision "${decision.title}"`);
}

interface CollectedSources { facts: StoryFacts; patches: StoryPatch[]; fingerprint: string; turns: ConversationTurn[]; lastHarness: string }

/** Turns, commits and patches for a story, all read from the transcript and Git. */
export async function collectStorySources(project: ProjectRecord, cwd: string, conversationId: string | null, sources: StorySources): Promise<CollectedSources> {
  const loaded = conversationId ? await loadConversationMessages(project, conversationId) : { messages: [], lastHarness: "" };
  return { ...await sourcesFromTurns(cwd, buildTurns(loaded.messages), Boolean(conversationId), sources), lastHarness: loaded.lastHarness };
}

/** Commits the turns printed (and Git still has), plus the selected pending files. */
export async function sourcesFromTurns(cwd: string, turns: ConversationTurn[], conversation: boolean, sources: StorySources): Promise<Omit<CollectedSources, "lastHarness">> {
  const commits: Array<StoryCommit & { files: Array<{ path: string; kind: GitChangeKind }> }> = [];
  if (sources.includeCommits) {
    for (const turn of turns) {
      for (const hash of turn.commits) {
        if (commits.length >= COMMIT_LIMIT) break;
        const detail = await gitCommitDetail(cwd, hash).catch(() => null);
        if (!detail || commits.some((commit) => commit.hash === detail.hash)) continue;
        commits.push({ hash: detail.hash, shortHash: detail.shortHash, subject: detail.subject, turn: turn.n, files: detail.files });
      }
    }
  }
  const patches: StoryPatch[] = [];
  const kinds = new Map<string, GitChangeKind[]>();
  const note = (path: string, kind: GitChangeKind) => kinds.set(path, [...kinds.get(path) ?? [], kind]);
  let size = 0;
  for (const commit of commits) {
    for (const file of commit.files) {
      const diff = await gitCommitFileDiff(cwd, commit.hash, file.path);
      if (diff.truncated) throw new GitReviewError(413, `The diff of ${file.path} in ${commit.shortHash} is too large for a story. Leave out this conversation's commits or pick fewer files.`);
      size += diff.patch.length;
      patches.push({ path: file.path, source: commit.shortHash, patch: diff.patch });
      note(file.path, file.kind);
    }
  }
  const pending = await pendingReviewDiff(cwd, sources.pendingPaths);
  for (const change of pending.changes) {
    if (patches.some((patch) => patch.source === "pending" && patch.path === change.path)) continue;
    patches.push({ path: change.path, source: "pending", patch: pending.patches[change.path] ?? "" });
    size += pending.patches[change.path]?.length ?? 0;
    note(change.path, change.kind);
  }
  if (!patches.length) throw new GitReviewError(400, "Nothing to explain. This scope has no commits and no pending files.");
  if (size > STORY_DIFF_LIMIT) throw new GitReviewError(413, `These changes are too large for a story (${size.toLocaleString("en-US")} characters of diff, the limit is ${STORY_DIFF_LIMIT.toLocaleString("en-US")}). Leave out this conversation's commits or pick fewer files.`);
  const files: StoryFile[] = [];
  for (const [path, history] of kinds) {
    const own = patches.filter((patch) => patch.path === path);
    const counts = own.map((patch) => lineCounts(patch.patch));
    const first = history[0];
    const last = history.at(-1);
    files.push({
      path,
      kind: last === "deleted" ? "deleted" : first === "added" || first === "untracked" ? "added" : first === "renamed" ? "renamed" : "modified",
      add: counts.reduce((sum, count) => sum + count.add, 0),
      del: counts.reduce((sum, count) => sum + count.del, 0),
      where: [...new Set(own.map((patch) => patch.source))],
      area: fileArea(path),
    });
  }
  const allPaths = files.map((file) => file.path);
  const storyTurns: StoryTurn[] = turns.map((turn) => ({
    n: turn.n, ...(turn.at ? { at: turn.at } : {}), user: turn.user.slice(0, 600),
    commits: commits.filter((commit) => commit.turn === turn.n).map((commit) => commit.shortHash),
    paths: allPaths.filter((path) => turn.text.includes(path)),
  }));
  const fingerprint = createHash("sha256").update(JSON.stringify([patches.map((patch) => [patch.path, patch.source, patch.patch]), turns.length, turns.at(-1)?.user ?? ""])).digest("hex");
  return {
    facts: { conversation, turns: storyTurns, commits: commits.map(({ files: _files, ...commit }) => commit), files },
    patches, fingerprint, turns,
  };
}

/** A compact per-turn summary for the prompt; older turns shrink first when it runs long. */
export function turnDigest(turns: ConversationTurn[], facts: StoryFacts): string {
  const render = (turn: ConversationTurn, room: number) => {
    const fact = facts.turns.find((item) => item.n === turn.n);
    return [
      `Turn ${turn.n}${turn.at ? ` at ${turn.at}` : ""}${fact?.commits.length ? `, commits ${fact.commits.join(", ")}` : ""}${fact?.paths.length ? `, touched ${fact.paths.join(", ")}` : ""}`,
      `User: ${turn.user.slice(0, room)}`,
      `Assistant: ${turn.assistant.slice(-room)}`,
    ].join("\n");
  };
  for (const room of [900, 500, 250, 120]) {
    const digest = turns.map((turn, index) => render(turn, index >= turns.length - 6 ? Math.max(room, 500) : room)).join("\n\n");
    if (digest.length <= DIGEST_LIMIT) return digest;
  }
  return turns.map((turn) => render(turn, 80)).join("\n\n").slice(-DIGEST_LIMIT);
}

const STORY_INSTRUCTIONS = `You write a change story: an explanation of code changes for a developer who has not read the code. Read the conversation digest and the diff, then return ONLY one JSON object, no prose and no code fences:
{"kind":"Feature"|"Fix"|"Refactor"|"Tests"|"Docs"|"Chore","title":string,
 "overview":{"what":string,"why":string,"notice":[string],"unchanged":string},
 "diagram":{"lanes":[{"id":string,"label":string}],"nodes":[{"id":string,"lane":string,"kind":"action"|"decision"|"process"|"model"|"store"|"source"|"error","label":string,"sub":string,"text":string,"files":[path]}],"edges":[{"from":id,"to":id,"label":string,"style":"solid"|"dashed"|"bad"}]},
 "timeline":[{"turns":[number],"title":string,"did":[string],"decided":[string],"pivot":string,"quiet":boolean}],
 "examples":[{"kind":"Happy path"|"Edge case"|"Failure"|"Navigation","title":string,"start":string,"steps":[{"you":string,"app":string,"says":string,"nodes":[id],"edges":["from>to"]}],"result":string}],
 "implementation":{"what":{path:string},"decisions":[{"title":string,"why":string,"instead":string,"turn":number|null}],"checks":[{"priority":"high"|"medium"|"low","text":string,"file":path|""}],"tests":[{"file":path,"name":string}]}}
Rules:
- Explain behavior first: what a user or caller sees change. Plain, short sentences. Two or three sentences for "what" and "why".
- diagram: the flow of the changed feature at runtime, 4 to 12 steps. Lanes are where steps run (for example User, Browser, Server, Database, External service). Arrows go forward only; never draw a loop. Labels at most 24 characters, sub at most 24. kind: action = a person or UI, decision = a branch, process = a server step, model = an AI model call, store = storage, source = something only read, error = an error shown. Edge labels at most 12 characters, style "bad" for failure paths and "dashed" for read-only inputs. "files" lists the changed files that implement the step.
- timeline: group consecutive conversation turns into phases that cover every turn in order. "did" says what changed in that phase, "decided" lists decisions, "pivot" explains a change of direction (empty when none), "quiet" is true when the phase changed nothing. Use an empty array when there is no conversation.
- examples: 2 to 5 concrete walkthroughs with real values from the change. Each step has "you" (what the person does, may be empty), "app" (what the app does), "says" (exact text the user sees, copied from the diff, or empty), and the diagram node ids and edge ids ("from>to") that the step exercises.
- implementation.what: one line per changed file. decisions: the main choices and the alternative not taken, with the turn it was made in when known. checks: what a reviewer should verify. tests: test cases added or changed in the diff.
- Use only file paths from Allowed paths and turn numbers from the digest. Never claim a bug without evidence. Do not edit files.`;

export interface GenerateChangeStoryInput {
  project: ProjectRecord;
  cwd: string;
  conversationId: string | null;
  sources: StorySources;
  harnessId: HarnessId;
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export async function generateChangeStory(input: GenerateChangeStoryInput): Promise<SavedChangeStory & { diff: string }> {
  const { project, cwd, conversationId, sources } = input;
  const collected = await collectStorySources(project, cwd, conversationId, sources);
  const { facts, patches } = collected;
  const diff = patches.map((patch) => `# ${patch.source === "pending" ? "Pending, not committed" : `Commit ${patch.source}`}\n${patch.patch}`).join("\n");
  const commits = facts.commits.map((commit) => `${commit.shortHash} (turn ${commit.turn}): ${commit.subject}`).join("\n");
  const prompt = [
    `Allowed paths: ${JSON.stringify(facts.files.map((file) => file.path))}`,
    `Turns: ${facts.turns.length}`,
    commits ? `Commits made in this conversation:\n${commits}` : "Commits made in this conversation: none included",
    facts.conversation ? `Conversation digest:\n${turnDigest(collected.turns, facts)}` : "No conversation: explain the pending changes from the diff alone.",
    `Diff:\n${diff}`,
  ].join("\n\n");
  if (prompt.length > STORY_INPUT_LIMIT) throw new GitReviewError(413, "This conversation and its changes are too large for one story. Leave out this conversation's commits or pick fewer files.");
  const result = await runGitReview({
    projectId: project.id, cwd, harnessId: input.harnessId, provider: input.provider, modelId: input.modelId, thinkingLevel: input.thinkingLevel,
    selection: { scope: "worktree" }, question: "", diff: prompt, instructions: STORY_INSTRUCTIONS,
  });
  let parsed: unknown;
  try { parsed = parseJson(result.answer); } catch { throw new GitReviewError(422, "Story rejected. The reviewer did not return valid JSON."); }
  const checked = storySchema.safeParse(parsed);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new GitReviewError(422, `Story rejected. The reviewer's answer is missing or misshapes ${issue.path.join(".") || "the story"}: ${issue.message}.`);
  }
  checkStory(checked.data, { paths: facts.files.map((file) => file.path), turns: facts.turns.length });
  return { story: checked.data, facts, patches, fingerprint: collected.fingerprint, sources, generatedAt: new Date().toISOString(), diff };
}

export interface StoryFreshness { fresh: boolean; newTurns: number; changedPaths: string[]; reason?: string }

/** Compares a saved story with the sources it would read now. */
export async function storyFreshness(project: ProjectRecord, cwd: string, conversationId: string | null, saved: SavedChangeStory): Promise<StoryFreshness> {
  try {
    const current = await collectStorySources(project, cwd, conversationId, saved.sources);
    const byPath = (patches: StoryPatch[]) => new Map(patches.reduce((map, patch) => map.set(patch.path, `${map.get(patch.path) ?? ""}${patch.source}\n${patch.patch}`), new Map<string, string>()));
    const before = byPath(saved.patches);
    const after = byPath(current.patches);
    const changedPaths = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path));
    return { fresh: current.fingerprint === saved.fingerprint, newTurns: Math.max(0, current.facts.turns.length - saved.facts.turns.length), changedPaths };
  } catch (error) {
    return { fresh: false, newTurns: 0, changedPaths: [], reason: error instanceof Error ? error.message : "The sources can no longer be read." };
  }
}

/** Commits this conversation printed in its git output and that still exist, for the toolbar count. */
export async function conversationCommits(project: ProjectRecord, cwd: string, conversationId: string): Promise<Array<{ shortHash: string; subject: string }>> {
  const turns = buildTurns((await loadConversationMessages(project, conversationId)).messages);
  const found: Array<{ hash: string; shortHash: string; subject: string }> = [];
  for (const hash of turns.flatMap((turn) => turn.commits)) {
    if (found.length >= COMMIT_LIMIT) break;
    const detail = await gitCommitDetail(cwd, hash).catch(() => null);
    if (detail && !found.some((commit) => commit.hash === detail.hash)) found.push({ hash: detail.hash, shortHash: detail.shortHash, subject: detail.subject });
  }
  return found.map(({ shortHash, subject }) => ({ shortHash, subject }));
}
