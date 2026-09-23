import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

interface QuickNote {
  id: string;
  projectId: string;
  title: string;
  content: string;
  harnessId: string;
  provider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  createdAt: string;
  updatedAt: string;
}

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
