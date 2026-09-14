import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { z } from "zod";
import { listProjects } from "../store.js";
import { TaskWorkspaceError } from "../task-workspaces.js";
import { updateTask } from "../tasks.js";
import type { TaskAttachment, TaskRecord } from "../types.js";
import { SessionWatcher } from "../watcher.js";
import { webSocketCloseReason } from "../websocket.js";
import { harnessPromptQueueIsDraining } from "./harness-chat.js";
import { handleSessionChange } from "./realtime.js";
import { taskUpdateSchema } from "./schemas.js";

export const sessionWatcher = new SessionWatcher(handleSessionChange);
listProjects().then((projects) => {
  for (const project of projects) sessionWatcher.ensureProject(project);
}).catch((error) => console.warn("Could not start session watchers", error));

export function promptTextWithAttachments(message: string, imageAttachments: Array<{ name: string; path: string }>, fileAttachments: Array<{ name: string; path: string }>): string {
  const parts: string[] = [];
  const body = message.trim();
  if (body) parts.push(body);
  if (imageAttachments.length) parts.push(`Image attachments:\n${imageAttachments.map((image) => `- ${image.name}: ${image.path}`).join("\n")}\nAnalyze them alongside the request. Use these paths when a tool needs the original image file.`);
  if (fileAttachments.length) parts.push(`File attachments:\n${fileAttachments.map((file) => `- ${file.name}: ${file.path}`).join("\n")}\nOpen these files from their paths when needed.`);
  return parts.join("\n\n").trim();
}

function safeAttachmentName(name: string): string { return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_"); }
async function persistAttachments(cwd: string, attachments: Array<{ name: string; data: string }>): Promise<Array<{ name: string; path: string }>> {
  if (!attachments.length) return [];
  const attachmentDir = path.join(cwd, ".joint-bob-attachments");
  await mkdir(attachmentDir, { recursive: true });
  const saved: Array<{ name: string; path: string }> = [];
  for (const attachment of attachments) {
    const filePath = path.join(attachmentDir, `${Date.now()}-${randomUUID()}-${safeAttachmentName(attachment.name)}`);
    await writeFile(filePath, Buffer.from(attachment.data, "base64"));
    saved.push({ name: attachment.name, path: filePath });
  }
  return saved;
}

export async function persistTaskAttachments(cwd: string, images: Array<{ name: string; mimeType: string; data: string }>, files: Array<{ name: string; mimeType: string; data: string }>): Promise<TaskAttachment[]> {
  const [savedImages, savedFiles] = await Promise.all([persistAttachments(cwd, images), persistAttachments(cwd, files)]);
  return [
    ...savedImages.map((saved, index) => ({ id: randomUUID(), kind: "image" as const, name: saved.name, mimeType: images[index].mimeType, path: path.relative(cwd, saved.path).split(path.sep).join("/") })),
    ...savedFiles.map((saved, index) => ({ id: randomUUID(), kind: "file" as const, name: saved.name, mimeType: files[index].mimeType, path: path.relative(cwd, saved.path).split(path.sep).join("/") })),
  ];
}

export function taskAttachmentFile(cwd: string, attachment: TaskAttachment): string {
  const attachmentRoot = path.resolve(cwd, ".joint-bob-attachments");
  const filePath = path.resolve(cwd, attachment.path);
  if (!filePath.startsWith(`${attachmentRoot}${path.sep}`)) throw new Error("Ticket attachment path is invalid");
  return filePath;
}
async function removeTaskAttachments(cwd: string, attachments: TaskAttachment[]): Promise<void> {
  for (const attachment of attachments) {
    try { await unlink(taskAttachmentFile(cwd, attachment)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
async function prepareTaskAttachmentUpdate(existing: TaskRecord, payload: z.infer<typeof taskUpdateSchema>) {
  const { attachmentIds, images, files, ...fields } = payload;
  const changesAttachments = attachmentIds !== undefined || images !== undefined || files !== undefined;
  if (!changesAttachments) return { update: fields, added: [] as TaskAttachment[], removed: [] as TaskAttachment[] };
  if (!existing.worktreePath) throw new TaskWorkspaceError("Ticket workspace is unavailable");
  const current = existing.attachments ?? [];
  const ids = attachmentIds ?? current.map((attachment) => attachment.id);
  z.array(z.string().uuid().refine((id) => current.some((attachment) => attachment.id === id), "Ticket attachment was not found"))
    .max(10).refine((values) => new Set(values).size === values.length, "Ticket attachments cannot repeat").parse(ids);
  const retained = ids.map((id) => current.find((attachment) => attachment.id === id)!);
  z.array(z.unknown()).max(4).parse([...retained.filter((attachment) => attachment.kind === "image"), ...(images ?? [])]);
  z.array(z.unknown()).max(6).parse([...retained.filter((attachment) => attachment.kind === "file"), ...(files ?? [])]);
  const added = await persistTaskAttachments(existing.worktreePath, images ?? [], files ?? []);
  return { update: { ...fields, attachments: [...retained, ...added] }, added, removed: current.filter((attachment) => !ids.includes(attachment.id)) };
}
export async function updateTaskWithAttachments(projectId: string, existing: TaskRecord, payload: z.infer<typeof taskUpdateSchema>): Promise<TaskRecord> {
  const prepared = await prepareTaskAttachmentUpdate(existing, payload);
  let updated: TaskRecord;
  try { updated = await updateTask(projectId, existing.id, prepared.update); }
  catch (error) { if (existing.worktreePath) await removeTaskAttachments(existing.worktreePath, prepared.added); throw error; }
  if (existing.worktreePath) await removeTaskAttachments(existing.worktreePath, prepared.removed);
  return updated;
}

export function claudeRunKey(projectId: string, sessionPath: string): string { return `${projectId}\n${sessionPath}`; }
export function claudeConnectionKey(projectId: string, sessionId: string | null): string { return `${projectId}:${sessionId ?? "new"}`; }
export const promptQueueIsDraining = harnessPromptQueueIsDraining;

function closeProxiedSocket(socket: WebSocket, code: number, reason: Buffer): void {
  if ([1005, 1006].includes(code)) socket.close();
  else socket.close(code, webSocketCloseReason(reason.toString()));
}
export function proxySocket(socket: WebSocket, upstream: WebSocket): void {
  let closing = false;
  const connectionTimeout = setTimeout(() => fail("Execution node connection timed out"), 10_000).unref();
  const fail = (reason: string): void => {
    if (closing) return;
    closing = true; clearTimeout(connectionTimeout); upstream.terminate(); socket.close(1011, webSocketCloseReason(reason));
  };
  upstream.once("open", () => clearTimeout(connectionTimeout));
  upstream.on("message", (raw, isBinary) => { if (socket.readyState === socket.OPEN) socket.send(raw, { binary: isBinary }); });
  socket.on("message", (raw, isBinary) => { if (upstream.readyState === upstream.OPEN) upstream.send(raw, { binary: isBinary }); });
  upstream.once("close", (code, reason) => { if (!closing) { closing = true; clearTimeout(connectionTimeout); closeProxiedSocket(socket, code, reason); } });
  socket.once("close", (code, reason) => { if (!closing) { closing = true; clearTimeout(connectionTimeout); closeProxiedSocket(upstream, code, reason); } });
  upstream.once("unexpected-response", (_request, response) => fail(`Execution node rejected connection (${response.statusCode})`));
  upstream.on("error", () => fail("Execution node connection failed"));
}
