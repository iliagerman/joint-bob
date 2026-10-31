import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { resolveDataDirectory } from "./data-directory.js";
import { ensureGitReviewThreadSchema, insertGitReviewThread, type GitReviewThread } from "./git-review-threads.js";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias, type ReplicationEvent } from "./replication.js";
import { loadStoryScript, saveStoryScript } from "./story-scripts.js";
import { storyScriptSchema, type StoryScript } from "./story-script-schema.js";
import type { HarnessId } from "./types.js";

// A saved story and its podcast follow the project to every machine it is shared with. The whole story travels in each
// event (stories do not change once written; only the script grows), so events can arrive in any order and repeat.

const short = (max: number) => z.string().min(1).max(max);
const storyThreadSchema = z.object({
  id: short(64),
  conversationId: short(240).nullable(),
  harnessId: short(60),
  provider: z.string().max(200),
  modelId: short(300),
  thinkingLevel: z.string().max(60),
  selection: z.object({
    repository: z.string().max(2000).optional(), scope: z.enum(["worktree", "commit", "context"]), revision: z.string().max(80).optional(),
    filePath: z.string().max(2000).optional(), staged: z.boolean().optional(), label: z.string().max(300).optional(),
  }).strict(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(600_000), createdAt: short(40) }).strict()).length(2),
  createdAt: short(40),
  updatedAt: short(40),
  expiresAt: short(40),
}).strict();

const storyPayloadSchema = z.object({
  projectId: short(120),
  thread: storyThreadSchema,
  script: storyScriptSchema.nullable(),
  originNodeId: short(120),
}).strict();

let databasePromise: Promise<DatabaseSync> | undefined;

async function database(): Promise<DatabaseSync> {
  databasePromise ??= (async () => {
    const dataDir = resolveDataDirectory();
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    ensureGitReviewThreadSchema(db);
    ensureReplicationSchema(db);
    return db;
  })();
  return databasePromise;
}

/** Offers a story, and its podcast once it has one, to the machines the project is shared with. */
export async function publishStory(thread: GitReviewThread, script: StoryScript | null, originNodeId: string): Promise<void> {
  const { projectId, snapshot: _snapshot, ...kept } = thread;
  enqueueReplicationEvent(await database(), {
    originNodeId, entityType: "story", entityKey: `${projectId}:${thread.id}`, operation: "upsert",
    payload: { projectId, thread: kept, script, originNodeId },
  });
}

export function applyStoryEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const checked = storyPayloadSchema.safeParse(event.payload);
  if (event.entityType !== "story" || event.operation !== "upsert" || !checked.success || checked.data.originNodeId !== event.originNodeId
    || event.entityKey !== `${checked.data.projectId}:${checked.data.thread.id}`) throw new Error("Malformed story replication payload");
  const story = checked.data;
  // A story that has already expired is not worth keeping, and the one here is pruned the same way.
  if (Date.parse(story.thread.expiresAt) <= Date.now()) return;
  const projectId = resolveProjectAlias(db, story.projectId);
  ensureGitReviewThreadSchema(db);
  insertGitReviewThread(db, { ...story.thread, harnessId: story.thread.harnessId as HarnessId, projectId, snapshot: "" });
  if (!story.script) return;
  const local = loadStoryScript(projectId, story.thread.id);
  if (!local || local.updatedAt < story.script.updatedAt) saveStoryScript(projectId, story.thread.id, story.script);
}
