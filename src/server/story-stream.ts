import { z } from "zod";
import { GitReviewError } from "../git-review.js";
import type { ProjectRecord } from "../types.js";
import type { ChangeStory, SavedChangeStory, StorySources } from "./git-change-story.js";
import { collectStorySources, checkStory, storySchema, STORY_INPUT_LIMIT, STORY_INSTRUCTIONS, turnDigest } from "./git-change-story.js";
import { runGitReview } from "./git-review-run.js";

type StorySection = "overview" | "diagram" | "timeline" | "examples" | "implementation" | "complete";

interface StreamChunk {
  section: StorySection;
  data?: unknown;
  progress: number;
  error?: string;
  // Complete section includes full story data
  _complete?: boolean;
  story?: z.infer<typeof storySchema>;
  facts?: any;
  patches?: any;
  fingerprint?: string;
  sources?: any;
  generatedAt?: string;
  diff?: string;
}

function parseJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
}

/** Generate story sections independently and stream them */
export async function* streamChangeStory(input: {
  project: ProjectRecord;
  cwd: string;
  conversationId: string | null;
  sources: StorySources;
  harnessId: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
}): AsyncGenerator<StreamChunk> {
  const collected = await collectStorySources(input.project, input.cwd, input.conversationId, input.sources);
  const { facts, patches } = collected;

  const diff = patches
    .map((patch) => `# ${patch.source === "pending" ? "Pending, not committed" : `Commit ${patch.source}`}\n${patch.patch}`)
    .join("\n");
  const commits = facts.commits
    .map(
      (commit) =>
        `${commit.shortHash}${commit.turn ? ` (turn ${commit.turn})` : ""}${commit.date ? ` ${commit.date}` : ""}: ${commit.subject}${commit.body ? `\n  ${commit.body.replace(/\n/g, "\n  ")}` : ""}`
    )
    .join("\n");

  const prompt = [
    `Allowed paths: ${JSON.stringify(facts.files.map((file) => file.path))}`,
    `Turns: ${facts.turns.length}`,
    commits ? `Commits, oldest first:\n${commits}` : "Commits: none included",
    facts.omitted ? `Diffs left out for size: ${JSON.stringify(facts.omitted)}. Describe these files only from the conversation, commit messages and line counts; never guess their contents.` : "",
    facts.conversation ? `Conversation digest:\n${turnDigest(collected.turns, facts)}` : input.sources.kind === "commits" ? "No conversation: explain the picked commits from their messages and diff. The timeline must be empty." : "No conversation: explain the pending changes from the diff alone.",
    `Diff:\n${diff}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  if (prompt.length > STORY_INPUT_LIMIT) {
    throw new GitReviewError(413, "These changes are too large for one story. Pick fewer commits or files.");
  }

  // Generate the full story first (parallel sections would require coordination)
  const result = await runGitReview({
    projectId: input.project.id,
    cwd: input.cwd,
    harnessId: input.harnessId,
    provider: input.provider,
    modelId: input.modelId,
    thinkingLevel: input.thinkingLevel,
    selection: { scope: "worktree" },
    question: "",
    diff: prompt,
    instructions: STORY_INSTRUCTIONS,
  });

  let parsed: unknown;
  try {
    parsed = parseJson(result.answer);
  } catch {
    throw new GitReviewError(422, "Story rejected. The reviewer did not return valid JSON.");
  }

  const checked = storySchema.safeParse(parsed);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new GitReviewError(422, `Story rejected. The reviewer's answer is missing or misshapes ${issue.path.join(".") || "the story"}: ${issue.message}.`);
  }

  checkStory(checked.data, { paths: facts.files.map((file) => file.path), turns: facts.turns.length });

  const story = checked.data;

  // Stream sections with progress
  const sections: Array<[StorySection, unknown]> = [
    ["overview", story.overview],
    ["diagram", story.diagram],
    ["timeline", story.timeline],
    ["examples", story.examples],
    ["implementation", story.implementation],
  ];

  for (let i = 0; i < sections.length; i++) {
    const [section, data] = sections[i];
    const progress = Math.round(((i + 1) / sections.length) * 100);
    yield { section, data, progress };
  }

  // Store the complete story for later retrieval
  // (the caller will save this in the git review thread)
  yield {
    section: "overview" as const, // Not really used; this signals completion
    data: { _complete: true, story, facts, patches, fingerprint: collected.fingerprint, sources: input.sources, generatedAt: new Date().toISOString(), diff },
    progress: 100,
  };
}
