import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebhook, webhookInputSchema } from "../src/webhooks.js";
import { listWebhookResources, removeWebhookResource, resolveWebhookResources, saveWebhookResource, snapshotWebhookResources, webhookResourceInstructions } from "../src/webhook-resources.js";

const input = webhookInputSchema.parse({ name: "Issues", target: { kind: "project", projectId: "p1" } });

test("webhook files have descriptions and immutable versions retained by accepted snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-resources-"));
  const db = new DatabaseSync(path.join(root, "node.db"));
  try {
    const { webhook } = createWebhook(db, input);
    const first = await saveWebhookResource(db, webhook.id, { kind: "file", name: "deals.csv", description: "Current deal export", bytes: Buffer.from("id,value\n1,2") }, { root });
    const snapshot = snapshotWebhookResources(db, webhook.id, "owner-a");
    const second = await saveWebhookResource(db, webhook.id, { kind: "file", id: first.id, name: "deals.csv", description: "Updated export", bytes: Buffer.from("id,value\n3,4") }, { root });
    assert.notEqual(first.versionId, second.versionId);
    await removeWebhookResource(db, webhook.id, first.id, { root });
    const resolved = await resolveWebhookResources(db, snapshot, { root });
    assert.equal(resolved.files.length, 1);
    assert.equal(resolved.files[0].description, "Current deal export");
    assert.equal(await readFile(resolved.files[0].path, "utf8"), "id,value\n1,2");
    assert.equal(listWebhookResources(db, webhook.id).length, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("webhook resources reject empty descriptions, oversized files and unsafe names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-resources-limits-"));
  const db = new DatabaseSync(path.join(root, "node.db"));
  try {
    const { webhook } = createWebhook(db, input);
    await assert.rejects(saveWebhookResource(db, webhook.id, { kind: "file", name: "x.csv", description: "  ", bytes: Buffer.from("x") }, { root }), /description/i);
    await assert.rejects(saveWebhookResource(db, webhook.id, { kind: "file", name: "../x.csv", description: "x", bytes: Buffer.from("x") }, { root }), /name/i);
    await assert.rejects(saveWebhookResource(db, webhook.id, { kind: "file", name: "big.csv", description: "x", bytes: Buffer.alloc(4 * 1024 * 1024 + 1) }, { root }), /4 MiB/i);
    assert.deepEqual(listWebhookResources(db, webhook.id), []);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("webhook resource instructions give paths and descriptions without including static contents", () => {
  const context = webhookResourceInstructions({ files: [{ name: "deals.csv", description: "Current deal export", path: "/private/webhook/deals.csv" }], tools: [{ name: "clean.py", description: "Check duplicate rows", usage: "python3 /private/webhook/clean.py", path: "/private/webhook/clean.py" }], skills: [{ name: "csv-review", path: "/private/webhook/skills/csv-review" }], memoryPath: "/private/webhook/MEMORY.md", memoryCli: "node \"$JOINT_BOB_WEBHOOK_MEMORY_CLI\"" });
  assert.match(context, /deals\.csv/);
  assert.match(context, /Current deal export/);
  assert.match(context, /\/private\/webhook\/deals\.csv/);
  assert.match(context, /SKILL\.md/);
  assert.match(context, /MEMORY\.md/);
  assert.match(context, /python3 \/private\/webhook\/clean\.py/);
  assert.doesNotMatch(context, /id,value/);
});

test("a saved resource version cannot be redirected through a file symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-resource-file-link-"));
  const db = new DatabaseSync(path.join(root, "node.db"));
  try {
    const { webhook } = createWebhook(db, input);
    const saved = await saveWebhookResource(db, webhook.id, { kind: "file", name: "safe.txt", description: "Safe", bytes: Buffer.from("inside") }, { root });
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "public");
    await unlink(saved.path);
    await symlink(outside, saved.path);
    await assert.rejects(resolveWebhookResources(db, snapshotWebhookResources(db, webhook.id, "owner-a"), { root }), /unavailable/i);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("webhook resource directories cannot be redirected through symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-resources-link-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "webhook-resources-outside-"));
  const db = new DatabaseSync(path.join(root, "node.db"));
  try {
    const { webhook } = createWebhook(db, input);
    const resourceRoot = path.join(root, "webhook-resources", webhook.id);
    await import("node:fs/promises").then(fs => fs.mkdir(path.dirname(resourceRoot), { recursive: true }));
    await symlink(outside, resourceRoot);
    await assert.rejects(saveWebhookResource(db, webhook.id, { kind: "file", name: "x.csv", description: "x", bytes: Buffer.from("x") }, { root }), /link/i);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
