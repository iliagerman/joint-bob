import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { after, before } from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { sessionTitleOverrides } from "../src/names.js";
import { addProject } from "../src/store.js";
import { bindWebhookTitle, webhookTitleAgentEnvironment } from "../src/webhook-title.js";

let bridge: Server;
let origin: string;
let root: string;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-webhook-title-api-"));
  bridge = createServer((await import("../src/app.js")).createApp());
  await new Promise<void>(resolve => bridge.listen(0, "127.0.0.1", resolve));
  const address = bridge.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  origin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>(resolve => bridge.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

async function post(token: string | undefined, body: unknown) {
  const response = await fetch(`${origin}/api/webhook-title/agent`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("title capability fills only its conversation's captured template through HTTP and the CLI", async () => {
  const project = await addProject("Webhook titles", path.join(root, "project"), { writeInstructions: false });
  const conversationId = randomUUID();
  await ensureConversationRecord(project.id, "pi", conversationId, (await getClusterNode()).id);
  bindWebhookTitle(project.id, conversationId, "pr-[PR_REVIEW]");
  const env = webhookTitleAgentEnvironment({ projectId: project.id, engine: "pi", conversationId });
  const token = env.JOINT_BOB_WEBHOOK_TITLE_TOKEN!;
  assert.equal((await post(undefined, { action: "status" })).status, 401);
  assert.equal((await post("bad", { action: "status" })).status, 401);
  assert.deepEqual(await post(token, { action: "status" }), { status: 200, body: { template: "pr-[PR_REVIEW]", placeholders: ["PR_REVIEW"] } });
  assert.equal((await post(token, { action: "fill", replacements: { PR_REVIEW: "Fix login timeout" }, conversationId: "someone-else" })).status, 400);
  assert.equal((await post(token, { action: "fill", replacements: { PR_REVIEW: "Fix login timeout", prefix: "changed" } })).status, 400);
  const result = await promisify(execFile)(process.execPath, ["bin/joint-bob-webhook-title.mjs", "fill", '{"PR_REVIEW":"Fix login timeout"}'], {
    env: { ...process.env, ...env, JOINT_BOB_WEBHOOK_TITLE_URL: `${origin}/api/webhook-title/agent` },
  });
  assert.deepEqual(JSON.parse(result.stdout), { title: "pr-Fix login timeout" });
  assert.equal((await sessionTitleOverrides())[conversationId], "pr-Fix login timeout");
  const other = webhookTitleAgentEnvironment({ projectId: project.id, engine: "pi", conversationId: randomUUID() });
  assert.equal((await post(other.JOINT_BOB_WEBHOOK_TITLE_TOKEN, { action: "fill", replacements: { PR_REVIEW: "other" } })).status, 404);
  const settings = await fetch(`${origin}/api/settings`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(settings.status, 401, "title tokens do not grant settings access");
});
