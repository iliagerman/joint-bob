import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createWebhook, deleteWebhook, getWebhook, webhookInputSchema, WebhookError } from "./webhooks.js";
import { ensureWebhookResourceDirectory, ensureWebhookResourceSchema } from "./webhook-resources.js";
import { listWebhookSkills } from "./webhook-skills.js";
import { ensureWebhookAgentSchema, revokeWebhookMemoryAgentAccess } from "./webhook-agent.js";

const tables = ["webhook_deliveries", "webhook_resource_versions", "webhook_resources", "webhook_memory_settings", "webhook_skill_versions", "webhook_skills", "webhook_conversation_bindings"] as const;
const rowSchema = z.record(z.union([z.string(), z.number(), z.null()]));
const relativePath = z.string().min(1).max(1000).refine(value => !value.includes("\\") && !value.includes("\0") && value.split("/").every(part => part !== "" && part !== "." && part !== ".."), "Invalid transfer file path");
export const webhookTransferSchema = z.object({
  id: z.string().uuid(), input: webhookInputSchema,
  createdAt: z.string(), lastReceivedAt: z.string().nullable(), receivedCount: z.number().int().nonnegative(),
  tables: z.array(z.object({ name: z.enum(tables), rows: z.array(rowSchema).max(10000) }).strict()).length(tables.length),
  files: z.array(z.object({ path: relativePath, data: z.string() }).strict()).max(10000),
}).strict();
export type WebhookTransfer = z.infer<typeof webhookTransferSchema>;

function ensureTables(db: DatabaseSync, id: string) {
  ensureWebhookResourceSchema(db);
  listWebhookSkills(db, id);
  ensureWebhookAgentSchema(db);
}

async function readFiles(root: string, directory = "", budget = { bytes: 0 }): Promise<WebhookTransfer["files"]> {
  const files: WebhookTransfer["files"] = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await readFiles(root, relative, budget));
    else {
      if (!entry.isFile()) throw new WebhookError(409, "Webhook files must not contain links");
      budget.bytes += (await lstat(path.join(root, relative))).size;
      if (budget.bytes > 36 * 1024 * 1024) throw new WebhookError(413, "Webhook resources exceed the 50 MiB encoded transfer limit");
      files.push({ path: relative, data: (await readFile(path.join(root, relative))).toString("base64") });
    }
  }
  return files;
}

export async function exportWebhookTransfer(db: DatabaseSync, id: string): Promise<WebhookTransfer> {
  const hook = getWebhook(db, id);
  if (!hook) throw new WebhookError(404, "Webhook not found");
  ensureTables(db, id);
  const { id: _id, createdAt, updatedAt: _updated, lastReceivedAt, receivedCount, ...input } = hook;
  const bundle = webhookTransferSchema.parse({ id, input, createdAt, lastReceivedAt, receivedCount,
    tables: tables.map(name => ({ name, rows: db.prepare(`SELECT * FROM ${name} WHERE webhook_id=?`).all(id).map(row => {
      if (name === "webhook_deliveries") { const { id: _deliveryId, ...delivery } = row; return delivery; }
      return row;
    }) })),
    files: await readFiles(await ensureWebhookResourceDirectory(id)),
  });
  if (Buffer.byteLength(JSON.stringify(bundle)) > 50 * 1024 * 1024) throw new WebhookError(413, "Webhook transfer exceeds 50 MiB");
  return bundle;
}

/** Installs paused. The source must be removed before the destination can be enabled. */
export async function installWebhookTransfer(db: DatabaseSync, bundle: WebhookTransfer) {
  if (getWebhook(db, bundle.id)) throw new WebhookError(409, "Webhook already exists on the destination; inspect both machines before retrying");
  ensureTables(db, bundle.id);
  if (new Set(bundle.tables.map(table => table.name)).size !== tables.length) throw new WebhookError(400, "Duplicate transfer table");
  for (const table of bundle.tables) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table.name})`).all().map(row => row.name));
    for (const row of table.rows) {
      if (row.webhook_id !== bundle.id || Object.keys(row).some(key => !columns.has(key))) throw new WebhookError(400, "Invalid webhook transfer row");
      if ("relative_path" in row) relativePath.parse(row.relative_path);
    }
  }
  const root = await ensureWebhookResourceDirectory(bundle.id);
  // Never overwrite files left by an interrupted install or a previous owner.
  if ((await readdir(root)).length) throw new WebhookError(409, "Webhook files already exist on the destination; inspect the earlier transfer");
  try {
    for (const file of bundle.files) {
      const destination = path.join(root, file.path);
      const data = Buffer.from(file.data, "base64");
      if (data.toString("base64") !== file.data) throw new WebhookError(400, "Invalid transfer file data");
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, data, { flag: "wx", mode: 0o600 });
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const created = createWebhook(db, { ...bundle.input, enabled: false });
      db.prepare("UPDATE webhooks SET id=?,created_at=?,last_received_at=?,received_count=? WHERE id=?").run(bundle.id, bundle.createdAt, bundle.lastReceivedAt, bundle.receivedCount, created.webhook.id);
      for (const table of bundle.tables) for (const row of table.rows) {
        const columns = Object.keys(row);
        db.prepare(`INSERT INTO ${table.name} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
      }
      db.exec("COMMIT");
      return { webhook: getWebhook(db, bundle.id)!, secret: created.secret };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

export async function removeTransferredWebhook(db: DatabaseSync, id: string) {
  const root = await ensureWebhookResourceDirectory(id);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new WebhookError(409, "Invalid webhook resource directory");
  db.exec("BEGIN IMMEDIATE");
  try {
    revokeWebhookMemoryAgentAccess(db, id);
    for (const table of tables) db.prepare(`DELETE FROM ${table} WHERE webhook_id=?`).run(id);
    deleteWebhook(db, id);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  await rm(root, { recursive: true });
}
