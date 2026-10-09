import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { getClusterNode } from "../../cluster.js";
import { getRuntimePeer, runtimeFetch } from "../runtime-peers.js";
import { ConversationOwnershipError } from "../../conversation-ownership.js";
import { listHarnessSessions } from "../../harnesses.js";
import { getProject } from "../../store.js";
import { TICKET_BASELINE_DIR, TICKET_MERGE_DIR } from "../../task-workspaces.js";
import { listTasks } from "../../tasks.js";
import { sendError } from "../http-auth.js";
import { assertProjectEditable } from "../projects.js";
import { projectFileCopySchema, projectFileDeleteSchema, projectFileUpdateSchema, TEXT_FILE_LIMIT } from "../schemas.js";
import { requireLocalConversationOwner } from "../sessions-helpers.js";
import { app } from "../state.js";
class ProjectFileError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
}
function projectFileMode(query) {
  if (query.download === "1") return "download";
  return query.browser === "1" ? "browser" : "view";
}
function projectPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function portablePathParts(value) {
  return value.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
}
function matchingPathSuffix(candidateParts, requestedParts) {
  let matched = 0;
  while (matched < candidateParts.length && matched < requestedParts.length && candidateParts[candidateParts.length - matched - 1] === requestedParts[requestedParts.length - matched - 1]) matched += 1;
  return matched;
}
async function verifiedProjectFile(projectRoot, candidate) {
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code ?? "")) return null;
    throw error;
  }
  if (!projectPathInside(projectRoot, resolved)) throw new ProjectFileError(403, "File is outside the project directory");
  const info = await stat(resolved);
  if (!info.isFile()) throw new ProjectFileError(400, "Path is not a file");
  return { resolved, info };
}
async function searchProjectFile(projectRoot, requestedPath) {
  const requestedParts = portablePathParts(requestedPath);
  const basename = requestedParts.at(-1);
  const entries = await readdir(projectRoot, { recursive: true, withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== basename) continue;
    const candidate = path.join(entry.parentPath, entry.name);
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
async function resolveProjectFile(projectId, requestedPath, taskId) {
  const project = await getProject(projectId);
  if (!project) throw new ProjectFileError(404, "Project not found");
  const pathValue = requestedPath.trim();
  if (!pathValue) throw new ProjectFileError(400, "File path is required");
  if (pathValue.length > 2e3) throw new ProjectFileError(400, "File path is too long");
  if (portablePathParts(pathValue).includes("..")) throw new ProjectFileError(403, "File is outside the project directory");
  const projectRoot = await resolutionRoot(projectId, project.path, taskId);
  const directPath = pathValue.replace(/\\/g, path.sep);
  let direct = null;
  if (path.isAbsolute(directPath)) {
    const absolute = path.resolve(directPath);
    let resolvedAbsolute = null;
    try {
      resolvedAbsolute = await realpath(absolute);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code ?? "")) throw error;
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
async function resolutionRoot(projectId, projectPath, taskId) {
  if (!taskId) return await realpath(projectPath);
  const task = (await listTasks(projectId)).find((candidate) => candidate.id === taskId);
  if (!task) throw new ProjectFileError(404, "Ticket was not found");
  if (!task.worktreePath) throw new ProjectFileError(404, "Ticket workspace is not available");
  return await realpath(task.worktreePath);
}
async function projectFileResolution(projectId, requestedPath, taskId) {
  return { path: (await resolveProjectFile(projectId, requestedPath, taskId)).relativePath };
}
function projectFileLinks(projectId, relativePath, nodeId, taskId) {
  const makeUrl = (route, mode = "view") => {
    const url = new URL(`/api/projects/${encodeURIComponent(projectId)}/${route}`, "http://joint-bob.local");
    url.searchParams.set("path", relativePath);
    if (nodeId) url.searchParams.set("nodeId", nodeId);
    if (taskId) url.searchParams.set("taskId", taskId);
    if (mode !== "view") url.searchParams.set(mode, "1");
    return `${url.pathname}${url.search}`;
  };
  return { path: relativePath, viewUrl: makeUrl("file"), downloadUrl: makeUrl("file", "download"), contentUrl: makeUrl("file-content"), browserUrl: makeUrl("file", "browser") };
}
function fileVersion(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function readableText(bytes) {
  try {
    return textFile(bytes);
  } catch {
    return null;
  }
}
function textFile(bytes) {
  if (bytes.includes(0)) throw new ProjectFileError(415, "File is not valid UTF-8 text");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProjectFileError(415, "File is not valid UTF-8 text");
  }
}
const INLINE_PROJECT_FILE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf"
};
function projectFileContentType(resolved) {
  return INLINE_PROJECT_FILE_TYPES[path.extname(resolved).toLowerCase()] ?? "text/plain; charset=utf-8";
}
const MARKDOWN_FILE_EXTENSIONS = /* @__PURE__ */ new Set([".md", ".markdown", ".mdown", ".mkd", ".mkdn"]);
const VIEW_LANGUAGES = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".fish": "fish",
  ".sql": "sql",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".xml": "xml",
  ".tf": "terraform",
  ".lua": "lua",
  ".pl": "perl",
  ".r": "r",
  ".dockerfile": "dockerfile",
  ".gradle": "gradle",
  ".makefile": "makefile"
};
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fileViewLanguage(resolved) {
  const extension = path.extname(resolved).toLowerCase();
  if (MARKDOWN_FILE_EXTENSIONS.has(extension)) return "markdown";
  return VIEW_LANGUAGES[extension] ?? VIEW_LANGUAGES[`.${path.basename(resolved).toLowerCase()}`] ?? "";
}
function fileViewPage(fileName, language, source) {
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
const BROWSER_FILE_EXTENSIONS = /* @__PURE__ */ new Set([".html", ".htm"]);
const BROWSER_FILE_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
async function sendProjectFile(response, projectId, requestedPath, mode, taskId) {
  const download = mode === "download";
  try {
    const { resolved, info } = await resolveProjectFile(projectId, requestedPath, taskId);
    const fileName = path.basename(resolved).replace(/["\r\n]/g, "");
    if (mode === "browser" && BROWSER_FILE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      response.setHeader("Content-Security-Policy", BROWSER_FILE_CSP);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
      response.setHeader("Content-Length", String(info.size));
      createReadStream(resolved).pipe(response);
      return;
    }
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
    if (error instanceof ProjectFileError) {
      sendError(response, error.status, error.message);
      return;
    }
    throw error;
  }
}
async function projectFileContent(projectId, requestedPath, taskId) {
  const { resolved, relativePath, info } = await resolveProjectFile(projectId, requestedPath, taskId);
  if (info.size > TEXT_FILE_LIMIT) throw new ProjectFileError(413, "File is too large to edit");
  const bytes = await readFile(resolved);
  return { path: relativePath, content: textFile(bytes), version: fileVersion(bytes) };
}
async function assertProjectFileConversationOwner(project, sessionId) {
  const session = (await listHarnessSessions(project)).find((candidate) => candidate.id === sessionId);
  if (!session) throw new ProjectFileError(409, "Conversation was not found on this node");
  try {
    await requireLocalConversationOwner(session.harnessId, session.id);
  } catch (error) {
    if (error instanceof ConversationOwnershipError) throw new ProjectFileError(409, error.message);
    throw error;
  }
}
async function updateProjectFileContent(projectId, requestedPath, payload, taskId) {
  const { project, resolved, relativePath, info } = await resolveProjectFile(projectId, requestedPath, taskId);
  await assertProjectEditable(project);
  await assertProjectFileConversationOwner(project, payload.sessionId);
  const nextBytes = Buffer.from(payload.content, "utf8");
  if (nextBytes.length > TEXT_FILE_LIMIT) throw new ProjectFileError(413, "File is too large to edit");
  const current = await readFile(resolved);
  if (fileVersion(current) !== payload.version) throw new ProjectFileError(409, "File changed since it was opened");
  textFile(current);
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, nextBytes, { mode: Number(info.mode) });
    await rename(temporary, resolved);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
  return { path: relativePath, version: fileVersion(nextBytes) };
}
async function proxyProjectFileResolution(peer, projectId, requestedPath, taskId) {
  const url = new URL("/api/cluster/project-file-resolution", peer.url);
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("path", requestedPath);
  if (taskId) url.searchParams.set("taskId", taskId);
  const routed = await runtimeFetch(url, { signal: AbortSignal.timeout(3e4) });
  const body = await routed.json().catch(() => null);
  if (!routed.ok) {
    if (typeof body?.error === "string") throw new ProjectFileError(routed.status, body.error);
    throw new ProjectFileError(502, "File node returned an invalid response");
  }
  if (!body || typeof body.path !== "string") throw new ProjectFileError(502, "File node returned an invalid response");
  return { path: body.path };
}
async function proxyProjectFile(response, peer, projectId, requestedPath, mode, taskId) {
  const url = new URL("/api/cluster/project-file", peer.url);
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("path", requestedPath);
  if (taskId) url.searchParams.set("taskId", taskId);
  if (mode !== "view") url.searchParams.set(mode, "1");
  const routed = await runtimeFetch(url, { signal: AbortSignal.timeout(3e4) });
  const headers = ["content-type", "content-disposition", "content-length", ...mode === "browser" ? ["content-security-policy"] : []];
  for (const header of headers) {
    const value = routed.headers.get(header);
    if (value) response.setHeader(header, value);
  }
  response.status(routed.status);
  if (!routed.body) {
    response.end();
    return;
  }
  Readable.fromWeb(routed.body).pipe(response);
}
app.get("/api/cluster/project-file-resolution", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const projectId = typeof request.query.projectId === "string" ? request.query.projectId : "";
    const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : void 0;
    response.json(await projectFileResolution(projectId, requestedPath, taskId));
  } catch (error) {
    if (error instanceof ProjectFileError) {
      sendError(response, error.status, error.message);
      return;
    }
    next(error);
  }
});
app.get("/api/cluster/project-file", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const projectId = typeof request.query.projectId === "string" ? request.query.projectId : "";
    const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : void 0;
    await sendProjectFile(response, projectId, requestedPath, projectFileMode(request.query), taskId);
  } catch (error) {
    next(error);
  }
});
async function taskOwnerNodeId(projectId, taskId, fallback) {
  const task = (await listTasks(projectId)).find((candidate) => candidate.id === taskId);
  return task?.currentNodeId ?? fallback;
}
app.get("/api/projects/:projectId/file-resolution", async (request, response, next) => {
  try {
    const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
    const requestedNodeId = typeof request.query.nodeId === "string" ? request.query.nodeId : "";
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : void 0;
    const local = await getClusterNode();
    const effectiveNodeId = taskId ? await taskOwnerNodeId(request.params.projectId, taskId, requestedNodeId) : requestedNodeId;
    if (effectiveNodeId && effectiveNodeId !== local.id) {
      const peer = await getRuntimePeer(effectiveNodeId);
      if (!peer) {
        sendError(response, 404, "File node not found");
        return;
      }
      const resolution2 = await proxyProjectFileResolution(peer, request.params.projectId, requestedPath, taskId);
      response.json(projectFileLinks(request.params.projectId, resolution2.path, effectiveNodeId, taskId));
      return;
    }
    const resolution = await projectFileResolution(request.params.projectId, requestedPath, taskId);
    response.json(projectFileLinks(request.params.projectId, resolution.path, void 0, taskId));
  } catch (error) {
    if (error instanceof ProjectFileError) {
      sendError(response, error.status, error.message);
      return;
    }
    next(error);
  }
});
app.get("/api/projects/:projectId/file", async (request, response, next) => {
  try {
    const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
    let requestedNodeId = typeof request.query.nodeId === "string" ? request.query.nodeId : "";
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : void 0;
    const local = await getClusterNode();
    if (taskId) requestedNodeId = await taskOwnerNodeId(request.params.projectId, taskId, requestedNodeId);
    if (requestedNodeId && requestedNodeId !== local.id) {
      const peer = await getRuntimePeer(requestedNodeId);
      if (!peer) {
        sendError(response, 404, "File node not found");
        return;
      }
      await proxyProjectFile(response, peer, request.params.projectId, requestedPath, projectFileMode(request.query), taskId);
      return;
    }
    await sendProjectFile(response, request.params.projectId, requestedPath, projectFileMode(request.query), taskId);
  } catch (error) {
    next(error);
  }
});
async function proxyProjectFileContent(response, peer, projectId, requestedPath, request, taskId) {
  const url = new URL("/api/cluster/project-file-content", peer.url);
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("path", requestedPath);
  if (taskId) url.searchParams.set("taskId", taskId);
  const routed = await runtimeFetch(url, {
    method: request?.method ?? "GET",
    headers: { ...request ? { "Content-Type": "application/json" } : {} },
    ...request ? { body: JSON.stringify(request.body) } : {},
    signal: AbortSignal.timeout(3e4)
  });
  const contentType = routed.headers.get("content-type");
  if (contentType) response.setHeader("Content-Type", contentType);
  response.status(routed.status).send(await routed.text());
}
async function sendProjectFileContent(response, projectId, requestedPath, payload, taskId) {
  try {
    response.json(payload ? await updateProjectFileContent(projectId, requestedPath, payload, taskId) : await projectFileContent(projectId, requestedPath, taskId));
  } catch (error) {
    if (error instanceof ProjectFileError) {
      sendError(response, error.status, error.message);
      return;
    }
    throw error;
  }
}
app.get("/api/cluster/project-file-content", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : void 0;
    await sendProjectFileContent(response, String(request.query.projectId ?? ""), String(request.query.path ?? ""), void 0, taskId);
  } catch (error) {
    next(error);
  }
});
app.put("/api/cluster/project-file-content", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : void 0;
    await sendProjectFileContent(response, String(request.query.projectId ?? ""), String(request.query.path ?? ""), projectFileUpdateSchema.parse(request.body), taskId);
  } catch (error) {
    next(error);
  }
});
for (const method of ["get", "put"]) {
  app[method]("/api/projects/:projectId/file-content", async (request, response, next) => {
    try {
      const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
      let nodeId = typeof request.query.nodeId === "string" ? request.query.nodeId : "";
      const taskId = typeof request.query.taskId === "string" ? request.query.taskId : void 0;
      const local = await getClusterNode();
      if (taskId) nodeId = await taskOwnerNodeId(request.params.projectId, taskId, nodeId);
      if (nodeId && nodeId !== local.id) {
        const peer = await getRuntimePeer(nodeId);
        if (!peer) {
          sendError(response, 404, "File node not found");
          return;
        }
        await proxyProjectFileContent(response, peer, request.params.projectId, requestedPath, method === "put" ? request : void 0, taskId);
        return;
      }
      await sendProjectFileContent(response, request.params.projectId, requestedPath, method === "put" ? projectFileUpdateSchema.parse(request.body) : void 0, taskId);
    } catch (error) {
      next(error);
    }
  });
}
async function resolveProjectDirectory(projectId, requestedDir, taskId) {
  const project = await getProject(projectId);
  if (!project) throw new ProjectFileError(404, "Project not found");
  const dirValue = requestedDir.trim();
  if (dirValue.length > 2e3) throw new ProjectFileError(400, "Directory path is too long");
  if (portablePathParts(dirValue).includes("..")) throw new ProjectFileError(403, "Directory is outside the project directory");
  const projectRoot = await resolutionRoot(projectId, project.path, taskId);
  let resolved;
  try {
    resolved = await realpath(path.resolve(projectRoot, dirValue.replace(/\\/g, path.sep) || "."));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code ?? "")) throw new ProjectFileError(404, "Directory not found");
    throw error;
  }
  if (!projectPathInside(projectRoot, resolved)) throw new ProjectFileError(403, "Directory is outside the project directory");
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new ProjectFileError(400, "Path is not a directory");
  const relativePath = path.relative(projectRoot, resolved).split(path.sep).join("/");
  return { project, projectRoot, resolved, relativePath };
}
async function listProjectFiles(projectId, requestedDir, taskId) {
  const { resolved, relativePath } = await resolveProjectDirectory(projectId, requestedDir, taskId);
  const dirents = await readdir(resolved, { withFileTypes: true });
  const entries = [];
  for (const entry of dirents) {
    if (!entry.isFile() && !entry.isDirectory()) continue;
    const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const size = entry.isFile() ? (await stat(path.join(resolved, entry.name))).size : null;
    entries.push({ name: entry.name, path: entryPath, type: entry.isDirectory() ? "directory" : "file", size });
  }
  entries.sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1);
  return { path: relativePath, entries };
}
async function resolveExactProjectFile(projectId, requestedPath, taskId) {
  const project = await getProject(projectId);
  if (!project) throw new ProjectFileError(404, "Project not found");
  const pathValue = requestedPath.trim();
  if (!pathValue) throw new ProjectFileError(400, "File path is required");
  if (pathValue.length > 2e3) throw new ProjectFileError(400, "File path is too long");
  if (path.isAbsolute(pathValue)) throw new ProjectFileError(400, "File path must be relative");
  if (portablePathParts(pathValue).includes("..")) throw new ProjectFileError(403, "File is outside the project directory");
  const projectRoot = await resolutionRoot(projectId, project.path, taskId);
  const direct = await verifiedProjectFile(projectRoot, path.resolve(projectRoot, pathValue.replace(/\\/g, path.sep)));
  if (!direct) throw new ProjectFileError(404, "File not found");
  const relativePath = path.relative(projectRoot, direct.resolved).split(path.sep).join("/");
  return { project, resolved: direct.resolved, relativePath };
}
async function deleteProjectFile(projectId, requestedPath, payload, taskId) {
  const { project, resolved, relativePath } = await resolveExactProjectFile(projectId, requestedPath, taskId);
  await assertProjectEditable(project);
  await assertProjectFileConversationOwner(project, payload.sessionId);
  await unlink(resolved);
  return { path: relativePath };
}
async function copyProjectFile(projectId, requestedPath, payload, taskId) {
  const source = await resolveExactProjectFile(projectId, requestedPath, taskId);
  await assertProjectEditable(source.project);
  await assertProjectFileConversationOwner(source.project, payload.sessionId);
  const destination = await resolveProjectDirectory(projectId, payload.destinationDir, taskId);
  const fileName = path.basename(source.resolved);
  try {
    await copyFile(source.resolved, path.join(destination.resolved, fileName), constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code === "EEXIST") throw new ProjectFileError(409, "A file with that name already exists in the destination");
    throw error;
  }
  return { path: destination.relativePath ? `${destination.relativePath}/${fileName}` : fileName };
}
async function proxyProjectFileJson(response, peer, clusterRoute, query, request) {
  const url = new URL(clusterRoute, peer.url);
  for (const [key, value] of Object.entries(query)) if (value) url.searchParams.set(key, value);
  const routed = await runtimeFetch(url, {
    method: request?.method ?? "GET",
    headers: { ...request ? { "Content-Type": "application/json" } : {} },
    ...request ? { body: JSON.stringify(request.body) } : {},
    signal: AbortSignal.timeout(3e4)
  });
  const contentType = routed.headers.get("content-type");
  if (contentType) response.setHeader("Content-Type", contentType);
  response.status(routed.status).send(await routed.text());
}
app.get("/api/cluster/project-files", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : void 0;
    response.json(await listProjectFiles(String(request.query.projectId ?? ""), String(request.query.dir ?? ""), taskId));
  } catch (error) {
    if (error instanceof ProjectFileError) {
      sendError(response, error.status, error.message);
      return;
    }
    next(error);
  }
});
app.post("/api/cluster/project-file-delete", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : void 0;
    response.json(await deleteProjectFile(String(request.query.projectId ?? ""), String(request.query.path ?? ""), projectFileDeleteSchema.parse(request.body), taskId));
  } catch (error) {
    if (error instanceof ProjectFileError) {
      sendError(response, error.status, error.message);
      return;
    }
    next(error);
  }
});
app.post("/api/cluster/project-file-copy", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : void 0;
    response.json(await copyProjectFile(String(request.query.projectId ?? ""), String(request.query.path ?? ""), projectFileCopySchema.parse(request.body), taskId));
  } catch (error) {
    if (error instanceof ProjectFileError) {
      sendError(response, error.status, error.message);
      return;
    }
    next(error);
  }
});
app.get("/api/projects/:projectId/files", async (request, response, next) => {
  try {
    const dir = typeof request.query.dir === "string" ? request.query.dir : "";
    let nodeId = typeof request.query.nodeId === "string" ? request.query.nodeId : "";
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : void 0;
    const local = await getClusterNode();
    if (taskId) nodeId = await taskOwnerNodeId(request.params.projectId, taskId, nodeId);
    if (nodeId && nodeId !== local.id) {
      const peer = await getRuntimePeer(nodeId);
      if (!peer) {
        sendError(response, 404, "File node not found");
        return;
      }
      await proxyProjectFileJson(response, peer, "/api/cluster/project-files", { projectId: request.params.projectId, dir, taskId: taskId ?? "" });
      return;
    }
    response.json(await listProjectFiles(request.params.projectId, dir, taskId));
  } catch (error) {
    if (error instanceof ProjectFileError) {
      sendError(response, error.status, error.message);
      return;
    }
    next(error);
  }
});
for (const [route, clusterRoute, handler] of [
  ["/api/projects/:projectId/file-delete", "/api/cluster/project-file-delete", (projectId, requestedPath, body, taskId) => deleteProjectFile(projectId, requestedPath, projectFileDeleteSchema.parse(body), taskId)],
  ["/api/projects/:projectId/file-copy", "/api/cluster/project-file-copy", (projectId, requestedPath, body, taskId) => copyProjectFile(projectId, requestedPath, projectFileCopySchema.parse(body), taskId)]
]) {
  app.post(route, async (request, response, next) => {
    try {
      const requestedPath = typeof request.query.path === "string" ? request.query.path : "";
      let nodeId = typeof request.query.nodeId === "string" ? request.query.nodeId : "";
      const taskId = typeof request.query.taskId === "string" ? request.query.taskId : void 0;
      const local = await getClusterNode();
      if (taskId) nodeId = await taskOwnerNodeId(request.params.projectId, taskId, nodeId);
      if (nodeId && nodeId !== local.id) {
        const peer = await getRuntimePeer(nodeId);
        if (!peer) {
          sendError(response, 404, "File node not found");
          return;
        }
        await proxyProjectFileJson(response, peer, clusterRoute, { projectId: request.params.projectId, path: requestedPath, taskId: taskId ?? "" }, request);
        return;
      }
      response.json(await handler(request.params.projectId, requestedPath, request.body, taskId));
    } catch (error) {
      if (error instanceof ProjectFileError) {
        sendError(response, error.status, error.message);
        return;
      }
      next(error);
    }
  });
}
