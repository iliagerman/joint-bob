import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveDataDirectory } from "./data-directory.js";

let pending: Promise<unknown> = Promise.resolve();
export function withSkillMutation<T>(action: () => Promise<T>): Promise<T> {
  const result = pending.then(action);
  pending = result.then(() => undefined, () => undefined);
  return result;
}

function marker(root: string, name: string, dataDir?: string): string {
  const key = createHash("sha256").update(`${path.resolve(root)}\0${name}`).digest("hex");
  return path.join(resolveDataDirectory(dataDir), "skill-removals", key);
}

export async function skillSuppressed(root: string, name: string, dataDir?: string): Promise<boolean> {
  try { await lstat(marker(root, name, dataDir)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export async function suppressSkill(root: string, name: string, dataDir?: string): Promise<void> {
  const file = marker(root, name, dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ root, name }), { mode: 0o600 });
}

export async function allowSkillImport(root: string, name: string, dataDir?: string): Promise<void> {
  await rm(marker(root, name, dataDir), { force: true });
}

export async function unlinkSkillAliases(destination: string, roots: string[]): Promise<void> {
  let target = path.resolve(destination);
  try { target = path.join(await realpath(path.dirname(destination)), path.basename(destination)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const reachesTarget = async (file: string): Promise<boolean> => {
    const visited = new Set<string>();
    while (visited.size < 64) {
      try {
        try { file = path.join(await realpath(path.dirname(file)), path.basename(file)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (file === target) return true;
        if (visited.has(file) || !(await lstat(file)).isSymbolicLink()) return false;
        visited.add(file);
        file = path.resolve(path.dirname(file), await readlink(file));
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
        throw error;
      }
    }
    return false;
  };
  // Resolve every chain before unlinking any entry, including already dangling aliases.
  const aliases = new Set<string>();
  for (const root of new Set(roots)) {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const file = path.join(root, entry.name);
        if (entry.isSymbolicLink() && await reachesTarget(file)) aliases.add(file);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const file of aliases) {
    try { await unlink(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function backupRemovedSkill(destination: string, dataDir?: string): Promise<string> {
  const backup = path.join(resolveDataDirectory(dataDir), "removed-skills", randomUUID(), path.basename(destination));
  await mkdir(path.dirname(backup), { recursive: true });
  await rename(destination, backup);
  return backup;
}

// Provenance lives outside discovered/synchronized skill folders. Passive native
// reconciliation must never adopt a received copy as an independently owned skill.
function receivedMarker(root: string, name: string, dataDir?: string): string {
  return `${marker(root, name, dataDir)}.received`;
}
export async function markReceived(root: string, name: string, owner: string, dataDir?: string): Promise<void> {
  const file = receivedMarker(root, name, dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, owner, { mode: 0o600 });
}
export async function unmarkReceived(root: string, name: string, dataDir?: string): Promise<void> {
  await rm(receivedMarker(root, name, dataDir), { force: true });
}
export async function receivedOwner(root: string, name: string, dataDir?: string): Promise<string | undefined> {
  try { return await readFile(receivedMarker(root, name, dataDir), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
