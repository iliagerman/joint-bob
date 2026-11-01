import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveDataDirectory } from "../src/data-directory.js";
import { GIT_REVIEW_THREAD_TTL_MS, GIT_STORY_TTL_MS, createGitReviewThread, ensureGitReviewThreadSchema, type GitReviewThread } from "../src/git-review-threads.js";
import { ensureReplicationSchema, type ReplicationEvent } from "../src/replication.js";
import { applyStoryEvent, publishStory } from "../src/story-replication.js";
import type { StoryScript } from "../src/story-script-schema.js";
import { readyStoryMovie } from "../src/server/story-podcast.js";
import type { ProjectRecord } from "../src/types.js";
import { loadStoryScript, pruneStoryFiles, resetStoryPruneClock, saveStoryScript, storyVoiceDirectory } from "../src/story-scripts.js";

const DAY = 24 * 60 * 60 * 1000;

function story(projectId: string) {
  return createGitReviewThread({
    projectId, conversationId: "c-1", harnessId: "claude", provider: "claude", modelId: "opus", thinkingLevel: "medium",
    selection: { scope: "worktree" }, snapshot: "the diff", question: "Generated change story", answer: JSON.stringify({ story: "saved" }), ttlMs: GIT_STORY_TTL_MS,
  });
}

function script(thread: GitReviewThread, updatedAt: string): StoryScript {
  const chapter = (title: string) => ({ title, location: "podcast" as const, mood: "calm" as const, visual: { kind: "flow" as const, nodes: [{ label: "A", sub: "", tone: "neutral" as const }, { label: "B", sub: "", tone: "good" as const }] }, lines: [{ who: "host" as const, text: "Hello.", reveal: 1 }] });
  return {
    title: "Greeting", chapters: [chapter("One"), chapter("Two"), chapter("Three")],
    writeup: { changed: ["a"], how: ["b"], why: ["c"], rejected: [], limits: [] },
    followUps: [], generatedAt: updatedAt, updatedAt, expiresAt: thread.expiresAt,
  };
}

/** What the second machine receives: the events the first one queued for this story. */
function queued(): ReplicationEvent[] {
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  const rows = db.prepare("SELECT * FROM replication_outbox WHERE entity_type = 'story' ORDER BY created_at, rowid").all() as Array<Record<string, string>>;
  db.close();
  return rows.map((row) => ({ id: row.event_id, originNodeId: row.origin_node_id, entityType: row.entity_type, entityKey: row.entity_key, operation: row.operation, payload: JSON.parse(row.payload), createdAt: row.created_at }));
}

function otherMachine(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureGitReviewThreadSchema(db);
  ensureReplicationSchema(db);
  return db;
}

const threadCount = (db: DatabaseSync, id: string) => (db.prepare("SELECT COUNT(*) AS n FROM git_review_threads WHERE id = ?").get(id) as { n: number }).n;

test("a story lives two days and a review keeps its week", () => {
  const written = story("project-ttl");
  assert.equal(Date.parse(written.expiresAt) - Date.parse(written.createdAt), 2 * DAY);
  const review = createGitReviewThread({ projectId: "project-ttl", harnessId: "claude", provider: "claude", modelId: "opus", thinkingLevel: "medium", selection: { scope: "worktree" }, snapshot: "", question: "Why?", answer: "Because." });
  assert.equal(Date.parse(review.expiresAt) - Date.parse(review.createdAt), GIT_REVIEW_THREAD_TTL_MS);
});

test("a story and its podcast reach another machine, once and in any order", async () => {
  const thread = story("project-sync");
  await publishStory(thread, null, "node-a");
  const first = script(thread, new Date(Date.now() - 1000).toISOString());
  await publishStory(thread, first, "node-a");
  const events = queued().filter((event) => event.entityKey === `project-sync:${thread.id}`);
  assert.equal(events.length, 2);
  const remote = otherMachine();
  // The later event first, then the story-only one: the script is not lost, and the thread is stored once.
  applyStoryEvent(remote, events[1]);
  applyStoryEvent(remote, events[0]);
  applyStoryEvent(remote, events[1]);
  assert.equal(threadCount(remote, thread.id), 1);
  const stored = remote.prepare("SELECT snapshot, expires_at FROM git_review_threads WHERE id = ?").get(thread.id) as { snapshot: string; expires_at: string };
  assert.equal(stored.snapshot, "", "the diff is not sent; the story carries its own patches");
  assert.equal(stored.expires_at, thread.expiresAt);
  assert.equal(loadStoryScript("project-sync", thread.id)?.updatedAt, first.updatedAt);
});

test("a newer script replaces an older one and an older script never replaces a newer one", async () => {
  const thread = story("project-order");
  const older = script(thread, new Date(Date.now() - 2000).toISOString());
  const newer = { ...script(thread, new Date(Date.now() - 1000).toISOString()), followUps: [{ question: "Why?", answer: "Because." }] };
  await publishStory(thread, newer, "node-a");
  await publishStory(thread, older, "node-a");
  const [withNewer, withOlder] = queued().filter((event) => event.entityKey === `project-order:${thread.id}`);
  const remote = otherMachine();
  applyStoryEvent(remote, withNewer);
  applyStoryEvent(remote, withOlder);
  assert.equal(loadStoryScript("project-order", thread.id)?.followUps.length, 1);
});

test("an expired story is not stored, and a malformed or mislabelled event is refused", async () => {
  const thread = story("project-bad");
  await publishStory(thread, script(thread, new Date().toISOString()), "node-a");
  const event = queued().find((item) => item.entityKey === `project-bad:${thread.id}`)!;
  const remote = otherMachine();
  const expired = structuredClone(event) as ReplicationEvent & { payload: { thread: { expiresAt: string } } };
  expired.payload.thread.expiresAt = new Date(Date.now() - 1000).toISOString();
  applyStoryEvent(remote, expired);
  assert.equal(threadCount(remote, thread.id), 0);
  assert.throws(() => applyStoryEvent(remote, { ...event, originNodeId: "someone-else" }), /Malformed story replication payload/);
  assert.throws(() => applyStoryEvent(remote, { ...event, entityKey: "project-bad:other" }), /Malformed story replication payload/);
  assert.throws(() => applyStoryEvent(remote, { ...event, payload: { ...(event.payload as object), extra: true } }), /Malformed story replication payload/);
});

test("expired scripts and old spoken lines are deleted, and fresh ones stay", () => {
  const live = story("project-prune");
  saveStoryScript("project-prune", live.id, script(live, new Date().toISOString()));
  const gone = { ...live, id: "expired-story", expiresAt: new Date(Date.now() - 1000).toISOString() };
  saveStoryScript("project-prune", gone.id, script(gone, new Date(Date.now() - 3 * DAY).toISOString()));
  mkdirSync(storyVoiceDirectory(), { recursive: true });
  const fresh = path.join(storyVoiceDirectory(), "fresh.wav");
  const old = path.join(storyVoiceDirectory(), "old.wav");
  writeFileSync(fresh, "x");
  writeFileSync(old, "x");
  const longAgo = new Date(Date.now() - 3 * DAY);
  utimesSync(old, longAgo, longAgo);
  resetStoryPruneClock();
  pruneStoryFiles();
  assert.equal(loadStoryScript("project-prune", gone.id), null);
  assert.ok(loadStoryScript("project-prune", live.id));
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
});

test("a ready movie is reused only from this conversation's change story that has one, and never from anything else", async () => {
  const project = { id: "ready-project" } as ProjectRecord;
  const nowIso = () => new Date().toISOString();
  const withoutScript = story(project.id);
  assert.equal(await readyStoryMovie(project, "/nowhere", "c-1", () => true), null, "a story with no movie has nothing to reuse");

  // A review comment thread or an Activity overview record is not a change story, even with a script beside it.
  const review = createGitReviewThread({ projectId: project.id, conversationId: "c-1", harnessId: "claude", provider: "claude", modelId: "opus", thinkingLevel: "medium", selection: { scope: "worktree" }, snapshot: "", question: "Generated review comments", answer: "{}", ttlMs: GIT_STORY_TTL_MS });
  saveStoryScript(project.id, review.id, script(review, nowIso()));
  assert.equal(await readyStoryMovie(project, "/nowhere", "c-1", () => true), null);

  // Another conversation's story and a story in another repository are left alone.
  const other = createGitReviewThread({ projectId: project.id, conversationId: "c-2", harnessId: "claude", provider: "claude", modelId: "opus", thinkingLevel: "medium", selection: { scope: "worktree" }, snapshot: "", question: "Generated change story", answer: "{}", ttlMs: GIT_STORY_TTL_MS });
  saveStoryScript(project.id, other.id, script(other, nowIso()));
  assert.equal(await readyStoryMovie(project, "/nowhere", "c-1", () => true), null);
  saveStoryScript(project.id, withoutScript.id, script(withoutScript, nowIso()));
  assert.equal(await readyStoryMovie(project, "/nowhere", "c-1", () => false), null);
});

