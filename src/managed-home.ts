import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectType } from "./types.js";

export interface ManagedHomePaths {
  projects: string;
  tickets: string;
  personalProjects: string;
  workProjects: string;
}

const managedIgnoreRules = ["/projects/", "/tickets/"];

export function defaultManagedHome(): string {
  return path.join(os.homedir(), "JointBob");
}

export function managedHomePaths(homePath: string): ManagedHomePaths {
  const home = path.resolve(homePath);
  const projects = path.join(home, "projects");
  return {
    projects,
    tickets: path.join(home, "tickets"),
    personalProjects: path.join(projects, "personal"),
    workProjects: path.join(projects, "work"),
  };
}

function managedProjectFolderName(name: string): string {
  return name.trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "") || "project";
}

export function managedProjectPath(homePath: string, type: ProjectType, name: string): string {
  const paths = managedHomePaths(homePath);
  const root = type === "work" ? paths.workProjects : paths.personalProjects;
  return path.join(root, managedProjectFolderName(name));
}

export async function ensureManagedHome(homePath: string): Promise<void> {
  const home = path.resolve(homePath);
  await mkdir(home, { recursive: true });
  const ignorePath = path.join(home, ".gitignore");
  let existing: string;
  try {
    existing = await readFile(ignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existing = "";
  }
  const lines = new Set(existing.split(/\r?\n/));
  const missing = managedIgnoreRules.filter((rule) => !lines.has(rule));
  if (!missing.length) return;
  await appendFile(ignorePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}
