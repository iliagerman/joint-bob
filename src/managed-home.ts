import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectType } from "./types.js";

export interface ManagedHomePaths {
  tickets: string;
}

/** `/projects/` stays so homes created by the previous layout keep ignoring their old tree. */
const baseIgnoreRules = ["/projects/", "/tickets/"];

export function defaultManagedHome(): string {
  return path.join(os.homedir(), "JointBob");
}

export function managedHomePaths(homePath: string): ManagedHomePaths {
  return { tickets: path.join(path.resolve(homePath), "tickets") };
}

/** Type ids and project names both become single path segments, so neither can escape the home. */
function managedFolderName(value: string, fallback: string): string {
  return value.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "") || fallback;
}

export function managedTypeFolderName(type: ProjectType): string {
  return managedFolderName(type, "personal");
}

export function managedTypeRoot(homePath: string, type: ProjectType): string {
  return path.join(path.resolve(homePath), managedTypeFolderName(type));
}

export function managedProjectPath(homePath: string, type: ProjectType, name: string): string {
  return path.join(managedTypeRoot(homePath, type), managedFolderName(name, "project"));
}

export async function ensureManagedHome(homePath: string, typeFolders: ProjectType[] = []): Promise<void> {
  const home = path.resolve(homePath);
  await mkdir(home, { recursive: true });
  const rules = [...baseIgnoreRules, ...typeFolders.map((type) => `/${managedTypeFolderName(type)}/`)];
  const ignorePath = path.join(home, ".gitignore");
  let existing: string;
  try {
    existing = await readFile(ignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existing = "";
  }
  const lines = new Set(existing.split(/\r?\n/));
  const missing = rules.filter((rule) => !lines.has(rule));
  if (!missing.length) return;
  await appendFile(ignorePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}
