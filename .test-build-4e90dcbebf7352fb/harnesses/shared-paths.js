import { open } from "node:fs/promises";
import path from "node:path";
function sessionCwds(project) {
  const paths = [
    project.path,
    ...project.macPath ? [project.macPath] : [],
    ...(project.locations ?? []).map((location) => location.path),
    ...project.additionalPaths ?? []
  ];
  return [...new Set(paths.map((cwd) => path.resolve(cwd)))];
}
const SYNC_CONFLICT = /\.sync-conflict-[^.]+(?=\.jsonl$)/;
function isSyncConflictPath(filePath) {
  return SYNC_CONFLICT.test(path.basename(filePath));
}
function canonicalTranscriptName(fileName) {
  return fileName.replace(SYNC_CONFLICT, "");
}
async function readTranscriptCwd(filePath, headerType) {
  let file;
  try {
    file = await open(filePath, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const lineEnd = buffer.subarray(0, bytesRead).indexOf(10);
    if (lineEnd < 0) return null;
    const header = JSON.parse(buffer.toString("utf8", 0, lineEnd));
    if (!header || typeof header !== "object" || Array.isArray(header)) return null;
    const value = header;
    return value.type === headerType && typeof value.cwd === "string" && path.isAbsolute(value.cwd) ? path.resolve(value.cwd) : null;
  } catch (error) {
    const code = error.code;
    if (error instanceof SyntaxError || code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  } finally {
    await file?.close();
  }
}
export {
  canonicalTranscriptName,
  isSyncConflictPath,
  readTranscriptCwd,
  sessionCwds
};
