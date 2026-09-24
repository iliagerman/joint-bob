import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

interface QuickNoteImage { id: string; kind: string; name: string; mimeType: string; data: string }
interface QuickNote {
  id: string;
  projectId: string;
  title: string;
  content: string;
  harnessId: string;
  provider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  nodeId: string | null;
  secretAccountIds: string[];
  images: QuickNoteImage[];
  scheduledAt: string | null;
  status: string;
  error: string | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}
interface QuickNoteQueue { enabled: boolean; maxParallel: number }

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let session: SignedIn;

test.before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-notes-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  session = await signIn(environment, node);
});

test.after(async () => {
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("quick notes persist settings, move between projects, and delete", async () => {
  const first = projectNamed(node, "Internal Assistant");
  const second = projectNamed(node, "Joint Bob");
  const created = await api<{ note: QuickNote }>(node, session, "POST", "/quick-notes", {
    projectId: first.id,
    title: "Check deploy logs",
    content: "Look at the retry spike after lunch.",
    harnessId: "pi",
    provider: "openai-codex",
    modelId: "gpt-5.2-codex",
    thinkingLevel: "high",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.note.projectId, first.id);
  assert.equal(created.body.note.title, "Check deploy logs");
  assert.equal(created.body.note.harnessId, "pi");
  assert.equal(created.body.note.modelId, "gpt-5.2-codex");
  assert.equal(created.body.note.status, "pending");

  const firstList = await api<{ notes: QuickNote[] }>(node, session, "GET", `/projects/${first.id}/quick-notes`);
  assert.deepEqual(firstList.body.notes.map((note) => note.id), [created.body.note.id]);

  const moved = await api<{ note: QuickNote }>(node, session, "PATCH", `/quick-notes/${created.body.note.id}`, {
    projectId: second.id,
    title: "Check production logs",
    content: "No agent should run this note.",
    harnessId: "claude",
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    thinkingLevel: null,
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.note.projectId, second.id);
  assert.equal(moved.body.note.content, "No agent should run this note.");

  const oldList = await api<{ notes: QuickNote[] }>(node, session, "GET", `/projects/${first.id}/quick-notes`);
  const newList = await api<{ notes: QuickNote[] }>(node, session, "GET", `/projects/${second.id}/quick-notes`);
  assert.equal(oldList.body.notes.length, 0);
  assert.equal(newList.body.notes.length, 1);

  const removed = await fetch(`${node.url}/api/quick-notes/${created.body.note.id}`, {
    method: "DELETE",
    headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken },
  });
  assert.equal(removed.status, 204);
  const empty = await api<{ notes: QuickNote[] }>(node, session, "GET", `/projects/${second.id}/quick-notes`);
  assert.equal(empty.body.notes.length, 0);
});

test("quick notes reject missing projects and blank titles", async () => {
  const project = projectNamed(node, "Internal Assistant");
  const missing = await api<{ error: string }>(node, session, "POST", "/quick-notes", {
    projectId: "missing-project",
    title: "Orphan",
    content: "",
    harnessId: "pi",
  });
  assert.equal(missing.status, 404);

  const blank = await api<{ error: string }>(node, session, "POST", "/quick-notes", {
    projectId: project.id,
    title: "   ",
    content: "Body",
    harnessId: "pi",
  });
  assert.equal(blank.status, 400);
});

test("quick notes store launch metadata and images against each paused draft", async () => {
  const project = projectNamed(node, "Internal Assistant");
  const image = { id: "0e0d44a7-0f4b-4a2b-9d64-97fdd63ff631", kind: "image", name: "spike.png", mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64") };
  const scheduledAt = "2026-02-03T04:05:06.000Z";
  const created = await api<{ note: QuickNote }>(node, session, "POST", "/quick-notes", {
    projectId: project.id,
    title: "Scheduled draft",
    content: "Later",
    harnessId: "pi",
    nodeId: node.nodeId,
    secretAccountIds: [],
    images: [image],
    scheduledAt,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const note = created.body.note;
  assert.equal(note.nodeId, node.nodeId);
  assert.deepEqual(note.secretAccountIds, []);
  assert.deepEqual(note.images, [image]);
  assert.equal(note.scheduledAt, scheduledAt);
  assert.equal(note.status, "pending");

  const fetched = await api<{ note: QuickNote }>(node, session, "GET", `/quick-notes/${note.id}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.body.note.images, [image], "a single note keeps returning its images base64");

  const everyProject = await api<{ notes: QuickNote[] }>(node, session, "GET", "/quick-notes");
  assert.ok(everyProject.body.notes.some((candidate) => candidate.id === note.id), "the backlog spans projects");

  // Draft fields are optional: an old payload still creates a pending note.
  const legacy = await api<{ note: QuickNote }>(node, session, "POST", "/quick-notes", {
    projectId: project.id,
    title: "Legacy shape",
    content: "Old client",
    harnessId: "pi",
  });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.body.note.nodeId, null);
  assert.deepEqual(legacy.body.note.secretAccountIds, []);
  assert.deepEqual(legacy.body.note.images, []);
  assert.equal(legacy.body.note.scheduledAt, null);

  const badImage = await api<{ error: string }>(node, session, "POST", "/quick-notes", {
    projectId: project.id,
    title: "Bad image",
    content: "Body",
    harnessId: "pi",
    images: [{ id: "not-a-uuid", kind: "image", name: "x.png", mimeType: "image/png", data: image.data }],
  });
  assert.equal(badImage.status, 400);

  const badSchedule = await api<{ error: string }>(node, session, "POST", "/quick-notes", {
    projectId: project.id,
    title: "Bad schedule",
    content: "Body",
    harnessId: "pi",
    scheduledAt: "next tuesday",
  });
  assert.equal(badSchedule.status, 400);
});

test("the quick note queue defaults off, validates, and updates", async () => {
  const initial = await api<{ queue: QuickNoteQueue }>(node, session, "GET", "/quick-notes/queue");
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.queue, { enabled: false, maxParallel: 1 });

  for (const maxParallel of [0, 21, 2.5]) {
    const rejected = await api<{ error: string }>(node, session, "PUT", "/quick-notes/queue", { queue: { enabled: false, maxParallel } });
    assert.equal(rejected.status, 400, `maxParallel ${maxParallel} must be rejected`);
  }

  // The queue stays disabled throughout: unscheduled notes from earlier tests would
  // otherwise be eligible the moment it switches on.
  const updated = await api<{ queue: QuickNoteQueue }>(node, session, "PUT", "/quick-notes/queue", { queue: { enabled: false, maxParallel: 4 } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.queue, { enabled: false, maxParallel: 4 });

  const reread = await api<{ queue: QuickNoteQueue }>(node, session, "GET", "/quick-notes/queue");
  assert.deepEqual(reread.body.queue, { enabled: false, maxParallel: 4 });

  const restored = await api<{ queue: QuickNoteQueue }>(node, session, "PUT", "/quick-notes/queue", { queue: { enabled: false, maxParallel: 1 } });
  assert.deepEqual(restored.body.queue, { enabled: false, maxParallel: 1 });
});
