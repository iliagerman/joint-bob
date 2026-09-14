import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ProjectRecord } from "../types.js";

export interface SessionProjectPaths extends Pick<ProjectRecord, "path" | "macPath" | "locations"> {
  additionalPaths?: string[];
}

export function sessionCwds(project: SessionProjectPaths): string[] {
  const paths = [
    project.path,
    ...(project.macPath ? [project.macPath] : []),
    ...(project.locations ?? []).map((location) => location.path),
    ...(project.additionalPaths ?? []),
  ];
  return [...new Set(paths.map((cwd) => path.resolve(cwd)))];
}

const SYNC_CONFLICT = /\.sync-conflict-[^.]+(?=\.jsonl$)/;

export function isSyncConflictPath(filePath: string): boolean {
  return SYNC_CONFLICT.test(path.basename(filePath));
}

export function canonicalTranscriptName(fileName: string): string {
  return fileName.replace(SYNC_CONFLICT, "");
}

export async function readTranscriptCwd(filePath: string, headerType: string): Promise<string | null> {
  let file: FileHandle | undefined;
  try {
    file = await open(filePath, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const lineEnd = buffer.subarray(0, bytesRead).indexOf(10);
    if (lineEnd < 0) return null;
    const header: unknown = JSON.parse(buffer.toString("utf8", 0, lineEnd));
    if (!header || typeof header !== "object" || Array.isArray(header)) return null;
    const value = header as Record<string, unknown>;
    return value.type === headerType && typeof value.cwd === "string" && path.isAbsolute(value.cwd)
      ? path.resolve(value.cwd)
      : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof SyntaxError || code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  } finally {
    await file?.close();
  }
}
