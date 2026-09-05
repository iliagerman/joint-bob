import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { Request, Response } from "express";
import { z } from "zod";
import { type ClusterPeer, getClusterNode, getClusterPeer } from "../../cluster.js";
import { ConversationOwnershipError } from "../../conversation-ownership.js";
import { listHarnessSessions } from "../../harnesses.js";
import { getProject } from "../../store.js";
import { TICKET_BASELINE_DIR, TICKET_MERGE_DIR } from "../../task-workspaces.js";
import { listTasks } from "../../tasks.js";
import type { ProjectRecord } from "../../types.js";
import { sendError } from "../http-auth.js";
import { assertProjectEditable } from "../projects.js";
import { projectFileUpdateSchema, TEXT_FILE_LIMIT } from "../schemas.js";
import { requireLocalConversationOwner } from "../sessions-helpers.js";
import { app } from "../state.js";

class ProjectFileError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

interface ProjectFileResolution {
  path: string;
  viewUrl: string;
  downloadUrl: string;
  contentUrl: string;
}

function projectPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function portablePathParts(value: string): string[] {
  return value.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
}

function matchingPathSuffix(candidateParts: string[], requestedParts: string[]): number {
  let matched = 0;
  while (matched < candidateParts.length && matched < requestedParts.length && candidateParts[candidateParts.length - matched - 1] === requestedParts[requestedParts.length - matched - 1]) matched += 1;
  return matched;
}

async function verifiedProjectFile(projectRoot: string, candidate: string): Promise<{ resolved: string; info: Awaited<ReturnType<typeof stat>> } | null> {
  let resolved: string;
  try { resolved = await realpath(candidate); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
  if (!projectPathInside(projectRoot, resolved)) throw new ProjectFileError(403, "File is outside the project directory");
  const info = await stat(resolved);
  if (!info.isFile()) throw new ProjectFileError(400, "Path is not a file");
  return { resolved, info };
}

async function searchProjectFile(projectRoot: string, requestedPath: string): Promise<{ resolved: string; relativePath: string; info: Awaited<ReturnType<typeof stat>> }> {
  const requestedParts = portablePathParts(requestedPath);
  const basename = requestedParts.at(-1);
  const entries = await readdir(projectRoot, { recursive: true, withFileTypes: true });
  const matches: Array<{ resolved: string; relativePath: string; info: Awaited<ReturnType<typeof stat>>; score: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== basename) continue;
    const candidate = path.join(entry.parentPath, entry.name);
    // The baseline snapshot and merge staging area mirror the whole tree; a
    // basename match inside them is a copy of the real file, never the answer.
    const relative = path.relative(projectRoot, candidate).split(path.sep).join("/");
    if (relative.startsWith(`${TICKET_BASELINE_DIR}/`) || relative.startsWith(`${TICKET_MERGE_DIR}/`)) continue;
    const verified = await verifiedProjectFile(projectRoot, candidate);
    if (!verified) continue;
    const relativePath = path.relative(projectRoot, verified.resolved).split(path.sep).join("/");
    matches.push({ ...verified, relativePath, score: matchingPathSuffix(portablePathParts(relativePath), requestedParts) });
  }
  if (!matches.length) throw new ProjectFileError(404, "File not found");
  const score = Math.max(...matches.map((match) => match.score));
  const best = matches.filter((match) => match.score === score).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (best.length > 1) throw new ProjectFileError(409, `File reference is ambiguous: ${best.slice(0, 5).map((match) => match.relativePath).join(", ")}`);
  return best[0];
}

async function resolveProjectFile(projectId: string, requestedPath: string, taskId?: string): Promise<{ project: ProjectRecord; resolved: string; relativePath: string; info: Awaited<ReturnType<typeof stat>> }> {
  const project = await getProject(projectId);
  if (!project) throw new ProjectFileError(404, "Project not found");
  const pathValue = requestedPath.trim();
  if (!pathValue) throw new ProjectFileError(400, "File path is required");
  if (pathValue.length > 2000) throw new ProjectFileError(400, "File path is too long");
  if (portablePathParts(pathValue).includes("..")) throw new ProjectFileError(403, "File is outside the project directory");
  const projectRoot = await resolutionRoot(projectId, project.path, taskId);
  const directPath = pathValue.replace(/\\/g, path.sep);
  // An absolute path only resolves directly when its REALPATH is inside the
  // root: comparing the literal string lets a symlinked prefix (/var vs
  // /private/var on macOS) fake an escape and push an exact workspace path into
  // the fuzzy search. Absolute paths pointing elsewhere (an agent quoting
  // another checkout) still fall back to the suffix search; relative paths go
  // through verifiedProjectFile, which 403s symlink escapes.
  let direct: Awaited<ReturnType<typeof verifiedProjectFile>> = null;
  if (path.isAbsolute(directPath)) {
    const absolute = path.resolve(directPath);
    let resolvedAbsolute: string | null = null;
    try { resolvedAbsolute = await realpath(absolute); }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if (resolvedAbsolute && projectPathInside(projectRoot, resolvedAbsolute)) direct = await verifiedProjectFile(projectRoot, absolute);
  } else {
    direct = await verifiedProjectFile(projectRoot, path.resolve(projectRoot, directPath));
  }
  if (direct) {
    const relativePath = path.relative(projectRoot, direct.resolved).split(path.sep).join("/");
    return { project, resolved: direct.resolved, relativePath, info: direct.info };
  }
  const match = await searchProjectFile(projectRoot, pathValue);
  return { project, resolved: match.resolved, relativePath: match.relativePath, info: match.info };
}

// A ticket-scoped resolution roots at the ticket workspace so agent paths resolve to
// the copy the agent actually edited, never to a same-named project file.
async function resolutionRoot(projectId: string, projectPath: string, taskId?: string): Promise<string> {
  if (!taskId) return await realpath(projectPath);
  const task = (await listTasks(projectId)).find((candidate) => candidate.id === taskId);
  if (!task) throw new ProjectFileError(404, "Ticket was not found");
  if (!task.worktreePath) throw new ProjectFileError(404, "Ticket workspace is not available");
  return await realpath(task.worktreePath);
}

async function projectFileResolution(projectId: string, requestedPath: string, taskId?: string): Promise<{ path: string }> {
  return { path: (await resolveProjectFile(projectId, requestedPath, taskId)).relativePath };
}

function projectFileLinks(projectId: string, relativePath: string, nodeId?: string, taskId?: string): ProjectFileResolution {
  const makeUrl = (route: string, download = false): string => {
    const url = new URL(`/api/projects/${encodeURIComponent(projectId)}/${route}`, "http://joint-bob.local");
    url.searchParams.set("path", relativePath);
    if (nodeId) url.searchParams.set("nodeId", nodeId);
    if (taskId) url.searchParams.set("taskId", taskId);
    if (download) url.searchParams.set("download", "1");
    return `${url.pathname}${url.search}`;
  };
  return { path: relativePath, viewUrl: makeUrl("file"), downloadUrl: makeUrl("file", true), contentUrl: makeUrl("file-content") };
}

function fileVersion(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

/** The file's text, or null when it is not UTF-8 text and can only be handed over raw. */
function readableText(bytes: Buffer): string | null {
  try { return textFile(bytes); } catch { return null; }
}

function textFile(bytes: Buffer): string {
  if (bytes.includes(0)) throw new ProjectFileError(415, "File is not valid UTF-8 text");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ProjectFileError(415, "File is not valid UTF-8 text"); }
}

// Browsers refuse to render a response whose Content-Type is wrong because every response
// carries `X-Content-Type-Options: nosniff`, so a bad guess shows an empty page. Extension
// lookup is no help for source code: `.ts` maps to video/mp2t and `.py` maps to nothing at
// all. Only the types a browser genuinely displays keep their own type; everything else is
// served as plain text so the View link shows the file.
const INLINE_PROJECT_FILE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

function projectFileContentType(resolved: string): string {
  return INLINE_PROJECT_FILE_TYPES[path.extname(resolved).toLowerCase()] ?? "text/plain; charset=utf-8";
}

// A text file served as text/plain is browser-default black-on-white with none of the
// app's typography or theme, and markdown is additionally a wall of raw syntax. The View
// link instead serves a page that renders the file with the same renderer the chat uses:
// markdown as prose, anything else as a highlighted code block. `script-src 'self'`
// forbids an inline script, so the source travels inside a hidden <pre> and
// /file-view.js renders it.
const MARKDOWN_FILE_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mkdn"]);

// The language label a rendered code block carries. An extension that is not listed
// still renders as a code block, just without a language name.
const VIEW_LANGUAGES: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".mjs": "javascript",
  ".cjs": "javascript", ".json": "json", ".py": "python", ".rb": "ruby", ".go": "go",
  ".rs": "rust", ".java": "java", ".kt": "kotlin", ".swift": "swift", ".c": "c", ".h": "c",
  ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp", ".php": "php", ".sh": "bash", ".bash": "bash",
  ".zsh": "bash", ".fish": "fish", ".sql": "sql", ".html": "html", ".css": "css",
  ".scss": "scss", ".yml": "yaml", ".yaml": "yaml", ".toml": "toml", ".ini": "ini",
  ".xml": "xml", ".tf": "terraform", ".lua": "lua", ".pl": "perl", ".r": "r",
  ".dockerfile": "dockerfile", ".gradle": "gradle", ".makefile": "makefile",
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The page renders "markdown" as prose and every other language as a code block. An
 * unrecognised extension is still a code block, just without a language name. */
function fileViewLanguage(resolved: string): string {
  const extension = path.extname(resolved).toLowerCase();
  if (MARKDOWN_FILE_EXTENSIONS.has(extension)) return "markdown";
  return VIEW_LANGUAGES[extension] ?? VIEW_LANGUAGES[`.${path.basename(resolved).toLowerCase()}`] ?? "";
}

function fileViewPage(fileName: string, language: string, source: string): string {
  const title = escapeHtml(fileName);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>${title}</title>
    <meta name="theme-color" content="#f2f2f0" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <script src="/boot.js"></script>
    <link rel="stylesheet" href="/styles.css" />
    <script type="module" src="/file-view.js"></script>
  </head>
  <body class="file-view">
    <main class="file-view-page">
      <p class="file-view-path" data-testid="file-view-path">${title}</p>
      <pre id="fileViewSource" data-language="${escapeHtml(language)}" hidden>${escapeHtml(source)}</pre>
      <div id="fileViewBody" class="message-content md" data-testid="file-view-markdown"></div>
    </main>
  </body>
</html>
`;
}

async function sendProjectFile(response: Response, projectId: string, requestedPath: string, download: boolean, taskId?: string): Promise<void> {
  try {
    const { resolved, info } = await resolveProjectFile(projectId, requestedPath, taskId);
    const fileName = path.basename(resolved).replace(/["\r\n]/g, "");
    // Only text renders on the page. A binary or oversized file falls through to the
    // byte stream below, which is what an image or a PDF needs anyway.
    const viewable = !download && !INLINE_PROJECT_FILE_TYPES[path.extname(resolved).toLowerCase()] && info.size <= TEXT_FILE_LIMIT;
    const source = viewable ? readableText(await readFile(resolved)) : null;
    if (source !== null) {
      const page = fileViewPage(fileName, fileViewLanguage(resolved), source);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Length", String(Buffer.byteLength(page)));
      response.end(page);
      return;
    }
    response.setHeader("Content-Type", projectFileContentType(resolved));
    response.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${fileName}"`);
    response.setHeader("Content-Length", String(info.size));
    createReadStream(resolved).pipe(response);
  } catch (error) {
    if (error instanceof ProjectFileError) { sendError(response, error.status, error.message); return; }
    throw error;
  }
}

async function projectFileContent(projectId: string, requestedPath: string, taskId?: string): Promise<{ path: string; content: string; version: string }> {
  const { resolved, relativePath, info } = await resolveProjectFile(projectId, requestedPath, taskId);
  if (info.size > TEXT_FILE_LIMIT) throw new ProjectFileError(413, "File is too large to edit");
  const bytes = await readFile(resolved);
  return { path: relativePath, content: textFile(bytes), version: fileVersion(bytes) };
}

async function assertProjectFileConversationOwner(project: ProjectRecord, sessionId: string): Promise<void> {
  const session = (await listHarnessSessions(project)).find((candidate) => candidate.id === sessionId);
  if (!session) throw new ProjectFileError(409, "Conversation was not found on this node");
  try {
    await requireLocalConversationOwner(session.path.startsWith("claude:") ? "claude" : "pi", session.id);
  } catch (error) {
    if (error instanceof ConversationOwnershipError) throw new ProjectFileError(409, error.message);
    throw error;
  }
}

async function updateProjectFileContent(projectId: string, requestedPath: string, payload: z.infer<typeof projectFileUpdateSchema>, taskId?: string): Promise<{ path: string; version: string }> {
  const { project, resolved, relativePath, info } = await resolveProjectFile(projectId, requestedPath, taskId);
  await assertProjectEditable(project);
  await assertProjectFileConversationOwner(project, payload.sessionId);
  const nextBytes = Buffer.from(payload.content, "utf8");
  if (nextBytes.length > TEXT_FILE_LIMIT) throw new ProjectFileError(413, "File is too large to edit");
  const current = await readFile(resolved);
  if (fileVersion(current) !== payload.version) throw new ProjectFileError(409, "File changed since it was opened");
  textFile(current);
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, nextBytes, { mode: Number(info.mode) }); await rename(temporary, resolved); }
  catch (error) {
    try { await unlink(temporary); }
    catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
  return { path: relativePath, version: fileVersion(nextBytes) };
}

async function proxyProjectFileResolution(peer: ClusterPeer, projectId: string, requestedPath: string, taskId?: string): Promise<{ path: string }> {
  const url = new URL("/api/cluster/project-file-resolution", peer.url);
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("path", requestedPath);
  if (taskId) url.searchParams.set("taskId", taskId);
  const routed = await fetch(url, { headers: { Authorization: `Bearer ${peer.token}` }, signal: AbortSignal.timeout(30_000) });
  const body = await routed.json().catch(() => null) as { path?: unknown; error?: unknown } | null;
  if (!routed.ok) {
    if (typeof body?.error === "string") throw new ProjectFileError(routed.status, body.error);
    throw new ProjectFileError(502, "File node returned an invalid response");
  }
  if (!body || typeof body.path !== "string") throw new ProjectFileError(502, "File node returned an invalid response");
  return { path: body.path };
}

async function proxyProjectFile(response: Response, peer: ClusterPeer, projectId: string, requestedPath: string, download: boolean, taskId?: string): Promise<void> {
  const url = new URL("/api/cluster/project-file", peer.url);
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("path", requestedPath);
  if (taskId) url.searchParams.set("taskId", taskId);
  if (download) url.searchParams.set("download", "1");
  const routed = await fetch(url, { headers: { Authorization: `Bearer ${peer.token}` }, signal: AbortSignal.timeout(30_000) });
  for (const header of ["content-type", "content-disposition", "content-length"] as const) {
    const value = routed.headers.get(header);
    if (value) response.setHeader(header, value);
  }
  response.status(routed.status);
  if (!routed.body) { response.end(); return; }
  Readable.fromWeb(routed.body as unknown as import("node:stream/web").ReadableStream).pipe(response);
}

app.get("/api/cluster/project-file-resolution", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const projectId = typeof request.query.projectId === "string" ? request.query.projectId : "";
    const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : undefined;
    response.json(await projectFileResolution(projectId, requestedPath, taskId));
  } catch (error) {
    if (error instanceof ProjectFileError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.get("/api/cluster/project-file", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const projectId = typeof request.query.projectId === "string" ? request.query.projectId : "";
    const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : undefined;
    await sendProjectFile(response, projectId, requestedPath, request.query.download === "1", taskId);
  } catch (error) { next(error); }
});

// A ticket-scoped file request routes to the task OWNER, not the ambient node:
// replicas hold no workspace, so the browser's activeNodeId would 404.
async function taskOwnerNodeId(projectId: string, taskId: string, fallback: string): Promise<string> {
  const task = (await listTasks(projectId)).find((candidate) => candidate.id === taskId);
  return task?.currentNodeId ?? fallback;
}

app.get("/api/projects/:projectId/file-resolution", async (request, response, next) => {
  try {
    const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
    const requestedNodeId = typeof request.query.nodeId === "string" ? request.query.nodeId : "";
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : undefined;
    const local = await getClusterNode();
    const effectiveNodeId = taskId ? await taskOwnerNodeId(request.params.projectId, taskId, requestedNodeId) : requestedNodeId;
    if (effectiveNodeId && effectiveNodeId !== local.id) {
      const peer = await getClusterPeer(effectiveNodeId);
      if (!peer) { sendError(response, 404, "File node not found"); return; }
      const resolution = await proxyProjectFileResolution(peer, request.params.projectId, requestedPath, taskId);
      response.json(projectFileLinks(request.params.projectId, resolution.path, effectiveNodeId, taskId));
      return;
    }
    const resolution = await projectFileResolution(request.params.projectId, requestedPath, taskId);
    response.json(projectFileLinks(request.params.projectId, resolution.path, undefined, taskId));
  } catch (error) {
    if (error instanceof ProjectFileError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.get("/api/projects/:projectId/file", async (request, response, next) => {
  try {
    const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
    let requestedNodeId = typeof request.query.nodeId === "string" ? request.query.nodeId : "";
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : undefined;
    const local = await getClusterNode();
    if (taskId) requestedNodeId = await taskOwnerNodeId(request.params.projectId, taskId, requestedNodeId);
    if (requestedNodeId && requestedNodeId !== local.id) {
      const peer = await getClusterPeer(requestedNodeId);
      if (!peer) { sendError(response, 404, "File node not found"); return; }
      await proxyProjectFile(response, peer, request.params.projectId, requestedPath, request.query.download === "1", taskId);
      return;
    }
    await sendProjectFile(response, request.params.projectId, requestedPath, request.query.download === "1", taskId);
  } catch (error) { next(error); }
});

async function proxyProjectFileContent(response: Response, peer: ClusterPeer, projectId: string, requestedPath: string, request?: Request, taskId?: string): Promise<void> {
  const url = new URL("/api/cluster/project-file-content", peer.url);
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("path", requestedPath);
  if (taskId) url.searchParams.set("taskId", taskId);
  const routed = await fetch(url, {
    method: request?.method ?? "GET",
    headers: { Authorization: `Bearer ${peer.token}`, ...(request ? { "Content-Type": "application/json" } : {}) },
    ...(request ? { body: JSON.stringify(request.body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const contentType = routed.headers.get("content-type");
  if (contentType) response.setHeader("Content-Type", contentType);
  response.status(routed.status).send(await routed.text());
}

async function sendProjectFileContent(response: Response, projectId: string, requestedPath: string, payload?: z.infer<typeof projectFileUpdateSchema>, taskId?: string): Promise<void> {
  try { response.json(payload ? await updateProjectFileContent(projectId, requestedPath, payload, taskId) : await projectFileContent(projectId, requestedPath, taskId)); }
  catch (error) {
    if (error instanceof ProjectFileError) { sendError(response, error.status, error.message); return; }
    throw error;
  }
}

app.get("/api/cluster/project-file-content", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : undefined;
    await sendProjectFileContent(response, String(request.query.projectId ?? ""), String(request.query.path ?? ""), undefined, taskId);
  } catch (error) { next(error); }
});

app.put("/api/cluster/project-file-content", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : undefined;
    await sendProjectFileContent(response, String(request.query.projectId ?? ""), String(request.query.path ?? ""), projectFileUpdateSchema.parse(request.body), taskId);
  } catch (error) { next(error); }
});

for (const method of ["get", "put"] as const) {
  app[method]("/api/projects/:projectId/file-content", async (request, response, next) => {
    try {
      const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
      let nodeId = typeof request.query.nodeId === "string" ? request.query.nodeId : "";
      const taskId = typeof request.query.taskId === "string" ? request.query.taskId : undefined;
      const local = await getClusterNode();
      if (taskId) nodeId = await taskOwnerNodeId(request.params.projectId, taskId, nodeId);
      if (nodeId && nodeId !== local.id) {
        const peer = await getClusterPeer(nodeId);
        if (!peer) { sendError(response, 404, "File node not found"); return; }
        await proxyProjectFileContent(response, peer, request.params.projectId, requestedPath, method === "put" ? request : undefined, taskId);
        return;
      }
      await sendProjectFileContent(response, request.params.projectId, requestedPath, method === "put" ? projectFileUpdateSchema.parse(request.body) : undefined, taskId);
    } catch (error) { next(error); }
  });
}
