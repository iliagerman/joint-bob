import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { importProject, registerProjectAliases } from "../src/store.js";
import { receiveReplicationBatch } from "../src/replication.js";
import { queuedPromptSnapshot, readQueueSettings } from "../src/prompt-queue.js";
import { getClusterNode } from "../src/cluster.js";
import { enqueuePrompt, listQueuedPrompts, editQueuedPrompt, cancelQueuedPrompt, mergeQueuedPrompts, swapQueuedPrompts } from "../src/prompt-queue.js";

test("late project aliases rekey replicated pending rows, tombstones and sequence state", async () => {
  await getClusterNode();
  const projectId = "queue-canonical";
  const aliasId = "queue-remote";
  const conversationId = randomUUID();
  const key = `${projectId}:${conversationId}`;
  const settings = { provider: "claude", modelId: "haiku", reasoning: "high" as const };
  await importProject({ id: projectId, name: projectId, path: "/remote/queue", createdAt: "2026-01-01", updatedAt: "2026-01-01" }, "/tmp/queue-alias-project");
  const events = [3, 1, 2].map((sequence) => {
    const id = randomUUID();
    return { id: randomUUID(), originNodeId: randomUUID(), entityType: "conversation.queue", entityKey: id, operation: "upsert", createdAt: "2026-01-01", payload: {
      projectId: aliasId, conversationId, id, sequence, revision: 1, createdAt: "2026-01-01",
      prompt: { id, promptText: String(sequence), displayText: String(sequence), messageText: String(sequence), promptSuffix: "", displaySuffix: "", attachmentPaths: [], settings: null, revision: 1 },
    } };
  });
  const deleted = { ...events[2], id: randomUUID(), operation: "delete", payload: { ...events[2].payload, prompt: null } };
  const active = { ...deleted, id: randomUUID(), entityKey: `${aliasId}:${conversationId}`, operation: "settings", payload: { ...deleted.payload, sequence: 8, activeSettings: settings } };
  const batch = [...events, deleted, active];
  assert.equal((await receiveReplicationBatch({ events: batch })).length, batch.length);
  await registerProjectAliases(projectId, [aliasId]);
  assert.deepEqual(listQueuedPrompts(key).map((prompt) => prompt.messageText), ["1", "3"]);
  assert.deepEqual(readQueueSettings(key), settings);
  const snapshot = queuedPromptSnapshot(key);
  assert.ok(snapshot.some((event) => event.operation === "delete" && event.entityKey === deleted.entityKey), "takeover snapshot must retain aliased tombstones");
  await receiveReplicationBatch({ events: [{ ...events[2], id: randomUUID() }] });
  const added = enqueuePrompt(key, "last", "last", { messageText: "last", promptSuffix: "", displaySuffix: "", attachmentPaths: [] });
  assert.deepEqual(listQueuedPrompts(key).map((prompt) => prompt.messageText), ["1", "3", "last"]);
  assert.equal(queuedPromptSnapshot(key).find((event) => event.entityKey === added.id)?.payload.sequence, 9);
});

test("same-millisecond prompts retain insertion order", async (context) => {
  await getClusterNode();
  context.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const expected = Array.from({ length: 40 }, (_, index) => String(index));
  for (const text of expected) enqueuePrompt("project:fifo", text, text, { messageText: text, promptSuffix: "", displaySuffix: "", attachmentPaths: [] });
  assert.deepEqual(listQueuedPrompts("project:fifo").map((prompt) => prompt.messageText), expected);
});

test("queued prompts can swap positions and reject stale swaps", async () => {
  await getClusterNode();
  const key = `project:${randomUUID()}`;
  const first = enqueuePrompt(key, "first", "first", { messageText: "first", promptSuffix: "", displaySuffix: "", attachmentPaths: [] });
  const second = enqueuePrompt(key, "second", "second", { messageText: "second", promptSuffix: "", displaySuffix: "", attachmentPaths: [] });
  const third = enqueuePrompt(key, "third", "third", { messageText: "third", promptSuffix: "", displaySuffix: "", attachmentPaths: [] });

  assert.equal(swapQueuedPrompts(key, [{ id: first.id, revision: first.revision }, { id: third.id, revision: third.revision }]), true);
  assert.deepEqual(listQueuedPrompts(key).map((prompt) => prompt.messageText), ["third", "second", "first"]);
  assert.equal(swapQueuedPrompts(key, [{ id: first.id, revision: first.revision }, { id: second.id, revision: second.revision }]), false);
});

test("selected queued prompts merge in queue order with attachments and first settings", async () => {
  await getClusterNode();
  const key = `project:${randomUUID()}`;
  const settings = { provider: "claude", modelId: "haiku", reasoning: "high" as const };
  const first = enqueuePrompt(key, "one\n\nFile attachments:\n- one.txt: /tmp/one.txt", "one\n\nAttached: one.txt", { messageText: "one", promptSuffix: "File attachments:\n- one.txt: /tmp/one.txt", displaySuffix: "Attached: one.txt", attachmentPaths: ["/tmp/one.txt"], settings });
  const middle = enqueuePrompt(key, "middle", "middle", { messageText: "middle", promptSuffix: "", displaySuffix: "", attachmentPaths: [] });
  const last = enqueuePrompt(key, "three\n\nImage attachments:\n- three.png: /tmp/three.png", "three\n\nAttached: three.png", { messageText: "three", promptSuffix: "Image attachments:\n- three.png: /tmp/three.png", displaySuffix: "Attached: three.png", attachmentPaths: ["/tmp/three.png"], images: [{ path: "/tmp/three.png", mimeType: "image/png" }] });

  const merged = mergeQueuedPrompts(key, [{ id: last.id, revision: last.revision }, { id: first.id, revision: first.revision }]);
  assert.equal(merged?.messageText, "one\n\nthree");
  assert.equal(merged?.promptText, "one\n\nthree\n\nFile attachments:\n- one.txt: /tmp/one.txt\n\nImage attachments:\n- three.png: /tmp/three.png");
  assert.deepEqual(merged?.attachmentPaths, ["/tmp/one.txt", "/tmp/three.png"]);
  assert.deepEqual(merged?.settings, settings);
  assert.deepEqual(listQueuedPrompts(key).map((prompt) => prompt.messageText), ["one\n\nthree", "middle"]);
  assert.equal(mergeQueuedPrompts(key, [{ id: middle.id, revision: middle.revision }, { id: last.id, revision: last.revision }]), null);
});

test("queued settings use globally unique IDs, persist and reject stale edits", async () => {
  await getClusterNode();
  const key = "project:conversation";
  const settings = { provider: "claude", modelId: "haiku", reasoning: "high" };
  const prompt = enqueuePrompt(key, "original", "original", { messageText: "original", promptSuffix: "", displaySuffix: "", attachmentPaths: [], settings });
  assert.match(String(prompt.id), /^[0-9a-f-]{36}$/);
  assert.deepEqual(listQueuedPrompts(key)[0].settings, settings);
  assert.equal(editQueuedPrompt(key, prompt.id, "saved", "saved", "saved", null, prompt.revision), true);
  assert.equal(editQueuedPrompt(key, prompt.id, "stale", "stale", "stale", settings, prompt.revision), false);
  const saved = listQueuedPrompts(key)[0];
  assert.equal(saved.messageText, "saved");
  assert.equal(saved.settings, null);
  assert.ok(cancelQueuedPrompt(key, prompt.id));
  assert.deepEqual(listQueuedPrompts(key), []);
});
