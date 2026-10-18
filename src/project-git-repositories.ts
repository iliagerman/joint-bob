import { lstat, opendir, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { GitReviewError, gitRepositoryRoot } from "./git-review.js";

const IGNORED = new Set([".git", "node_modules", "vendor", ".cache", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".turbo", "dist", "build", "coverage", "target", ".idea", ".gradle"]);
const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 16;

/** Bounded metadata scan; git files include worktrees and submodules. */
export async function discoverGitRepositories(root: string): Promise<{ repositories: Array<{ path: string; name: string }>; truncated: boolean }> {
  const repositories: Array<{ path: string; name: string }> = [];
  let truncated = false;
  let remaining = MAX_ENTRIES;
  async function visit(directory: string, relative: string, depth: number): Promise<void> {
    const entries: Dirent[] = [];
    try {
      if (!(await lstat(directory)).isDirectory()) return;
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (remaining-- <= 0) { truncated = true; return; }
        entries.push(entry);
      }
    } catch { truncated = true; return; }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (entries.some((entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile()))) {
      repositories.push({ path: relative, name: path.basename(directory) });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED.has(entry.name)) continue;
      if (depth >= MAX_DEPTH || remaining <= 0) { truncated = true; continue; }
      await visit(path.join(directory, entry.name), relative === "." ? entry.name : `${relative}/${entry.name}`, depth + 1);
    }
  }
  await visit(path.resolve(root), ".", 0);
  repositories.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { repositories, truncated };
}

/** Omission keeps legacy cwd semantics, including Git's ancestor discovery. */
export async function resolveGitRepository(root: string, repository?: string): Promise<string> {
  if (repository === undefined) return root;
  if (!repository || repository.includes("\0") || repository.includes("\\") || path.isAbsolute(repository) || path.win32.isAbsolute(repository) || repository.split("/").includes("..")) {
    throw new GitReviewError(400, "Invalid repository path");
  }
  try {
    const base = await realpath(root);
    const selected = await realpath(path.resolve(base, repository));
    const relative = path.relative(base, selected);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new GitReviewError(400, "Repository path escapes project");
    if (await realpath(await gitRepositoryRoot(selected)) !== selected) throw new GitReviewError(400, "Select an exact Git repository root");
    return selected;
  } catch (error) {
    if (error instanceof GitReviewError) throw error;
    throw new GitReviewError(400, "Invalid Git repository path");
  }
}
