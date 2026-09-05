import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import type { ChildProcess } from "node:child_process";

interface TicketAttachment {
  id: string;
  kind: "image" | "file";
  name: string;
  mimeType: string;
  path: string;
}

interface Ticket {
  id: string;
  description: string;
  worktreePath: string;
  attachments: TicketAttachment[];
}

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let session: SignedIn;
let server: ChildProcess;
let syncthing: Server;
let capturePath: string;

async function startFakeSyncthing(): Promise<string> {
  syncthing = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/rest/config/folders") { response.end("[]"); return; }
    if (request.method === "POST" && request.url === "/rest/config/folders") { response.end("{}"); return; }
    if (request.method === "GET" && request.url === "/rest/system/status") { response.end('{"myID":"LOCAL"}'); return; }
    if (request.method === "GET" && request.url?.startsWith("/rest/db/ignores")) { response.end('{"ignore":[]}'); return; }
    if (request.method === "POST" && request.url?.startsWith("/rest/db/ignores")) { response.end("{}"); return; }
    response.statusCode = 404;
    response.end();
  });
  const port = await new Promise<number>((resolve) => syncthing.listen(0, "127.0.0.1", () => resolve((syncthing.address() as { port: number }).port)));
  return `http://127.0.0.1:${port}`;
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ticket-attachments-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  capturePath = path.join(root, "claude-prompt.txt");
  const fakeClaude = path.join(root, "fake-claude.mjs");
  await writeFile(fakeClaude, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nlet prompt = "";\nfor await (const chunk of process.stdin) prompt += chunk;\nwriteFileSync(process.env.CAPTURE_PATH, prompt);\nconsole.log(JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111", tools: [] }));\nconsole.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }));\nconsole.log(JSON.stringify({ type: "result", is_error: false }));\n`);
  await chmod(fakeClaude, 0o755);
  const syncthingUrl = await startFakeSyncthing();
  server = await startDevNode(environment, node, { PI_MOBILE_WEB_SYNCTHING_URL: syncthingUrl, PI_MOBILE_WEB_SYNCTHING_API_KEY: "test-key", CAPTURE_PATH: capturePath });
  session = await signIn(environment, node);
  const settings = await api<{ pi: Record<string, unknown>; claude: Record<string, unknown>; syncthing: Record<string, unknown>; projects: Record<string, unknown> }>(node, session, "GET", "/settings");
  const saved = await api(node, session, "PUT", "/settings", { ...settings.body, claude: { ...settings.body.claude, executable: fakeClaude } });
  assert.equal(saved.status, 200);
});

after(async () => {
  if (server) await stopDevNode(server);
  if (syncthing) await new Promise<void>((resolve, reject) => syncthing.close((error) => error ? reject(error) : resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});

async function createTicket(body: Record<string, unknown>): Promise<{ status: number; body: { task: Ticket } }> {
  const project = projectNamed(node, "Joint Bob");
  return api(node, session, "POST", `/projects/${project.id}/tasks`, {
    title: "Attachment ticket",
    description: "Read the attached specification.",
    ...body,
  });
}

test("ticket creation persists image and file attachments in its workspace", async () => {
  const response = await createTicket({
    images: [{ name: "screen shot.png", mimeType: "image/png", data: Buffer.from("png-data").toString("base64") }],
    files: [{ name: "../requirements.txt", mimeType: "text/plain", data: Buffer.from("ship it\n").toString("base64") }],
  });

  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.task.description, "Read the attached specification.");
  assert.deepEqual(response.body.task.attachments.map(({ kind, name, mimeType }) => ({ kind, name, mimeType })), [
    { kind: "image", name: "screen shot.png", mimeType: "image/png" },
    { kind: "file", name: "../requirements.txt", mimeType: "text/plain" },
  ]);
  for (const attachment of response.body.task.attachments) {
    assert.equal(path.isAbsolute(attachment.path), false, "attachment paths stay portable between nodes");
    assert.equal(attachment.path.startsWith(".joint-bob-attachments/"), true);
  }
  assert.equal(await readFile(path.join(response.body.task.worktreePath, response.body.task.attachments[0].path), "utf8"), "png-data");
  assert.equal(await readFile(path.join(response.body.task.worktreePath, response.body.task.attachments[1].path), "utf8"), "ship it\n");
});

test("ticket edits retain selected attachments, remove others, and add new files", async () => {
  const created = await createTicket({
    files: [
      { name: "keep.txt", mimeType: "text/plain", data: Buffer.from("keep").toString("base64") },
      { name: "remove.txt", mimeType: "text/plain", data: Buffer.from("remove").toString("base64") },
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const [kept, removed] = created.body.task.attachments;
  const project = projectNamed(node, "Joint Bob");

  const updated = await api<{ task: Ticket }>(node, session, "PATCH", `/projects/${project.id}/tasks/${created.body.task.id}`, {
    description: "Updated description",
    attachmentIds: [kept.id],
    files: [{ name: "new.pdf", mimeType: "application/pdf", data: Buffer.from("pdf").toString("base64") }],
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.task.description, "Updated description");
  assert.deepEqual(updated.body.task.attachments.map((attachment) => attachment.name), ["keep.txt", "new.pdf"]);
  await assert.rejects(readFile(path.join(created.body.task.worktreePath, removed.path)), /ENOENT/);
  assert.equal(await readFile(path.join(created.body.task.worktreePath, updated.body.task.attachments[1].path), "utf8"), "pdf");
});

test("ticket attachments are included in the agent's opening prompt", async () => {
  const response = await createTicket({
    status: "in_progress",
    engine: "claude",
    phaseConfig: { in_progress: { engine: "claude", provider: "", modelId: "claude-opus-5", effort: "default" } },
    files: [{ name: "agent-notes.md", mimeType: "text/markdown", data: Buffer.from("agent context").toString("base64") }],
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));

  let prompt = "";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { prompt = await readFile(capturePath, "utf8"); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(prompt, /File attachments:/);
  assert.match(prompt, /agent-notes\.md:/);
  assert.match(prompt, new RegExp(response.body.task.attachments[0].path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("ticket attachments use the conversation count limits", async () => {
  const response = await createTicket({
    images: Array.from({ length: 5 }, (_, index) => ({
      name: `image-${index}.png`,
      mimeType: "image/png",
      data: Buffer.from(`${index}`).toString("base64"),
    })),
  });

  assert.equal(response.status, 400);

  const oversized = await createTicket({
    files: [{
      name: "too-large.bin",
      mimeType: "application/octet-stream",
      data: Buffer.alloc((4 * 1024 * 1024) + 1).toString("base64"),
    }],
  });
  assert.equal(oversized.status, 400, JSON.stringify(oversized.body));
});
