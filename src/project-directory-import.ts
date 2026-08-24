import { chmod, cp, lstat, mkdir, realpath, rename, rm, symlink, utimes } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ProjectDirectoryImportMode = "copy" | "move" | "move-link";

export class ProjectDirectoryImportError extends Error {}

function pathContains(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function assertImportPaths(sourcePath: string, destinationPath: string): Promise<void> {
  let source;
  try {
    source = await lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ProjectDirectoryImportError("Source project folder does not exist");
    throw error;
  }
  if (source.isSymbolicLink() || !source.isDirectory()) throw new ProjectDirectoryImportError("Source project folder must be a real directory");
  if (pathContains(sourcePath, destinationPath) || pathContains(destinationPath, sourcePath)) {
    throw new ProjectDirectoryImportError("Source and managed project folders must not contain each other");
  }
  try {
    await lstat(destinationPath);
    throw new ProjectDirectoryImportError("Managed project folder already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function copyDirectory(sourcePath: string, destinationPath: string): Promise<void> {
  const source = await lstat(sourcePath);
  try {
    await mkdir(destinationPath, { mode: source.mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ProjectDirectoryImportError("Managed project folder already exists");
    throw error;
  }
  try {
    await cp(sourcePath, destinationPath, {
      recursive: true,
      errorOnExist: false,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    await chmod(destinationPath, source.mode);
    await utimes(destinationPath, source.atime, source.mtime);
  } catch (error) {
    await rm(destinationPath, { recursive: true, force: true });
    throw error;
  }
}

async function moveDirectory(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await rename(sourcePath, destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyDirectory(sourcePath, destinationPath);
    try {
      await rm(sourcePath, { recursive: true });
    } catch (removeError) {
      await rm(destinationPath, { recursive: true, force: true });
      throw removeError;
    }
  }
}

async function moveDirectoryWithLink(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await rename(sourcePath, destinationPath);
    try {
      await symlink(destinationPath, sourcePath, "dir");
    } catch (error) {
      await rename(destinationPath, sourcePath);
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyDirectory(sourcePath, destinationPath);
    const backupPath = `${sourcePath}.joint-bob-import-${randomUUID()}`;
    await rename(sourcePath, backupPath);
    try {
      await symlink(destinationPath, sourcePath, "dir");
      await rm(backupPath, { recursive: true });
    } catch (linkError) {
      await rm(sourcePath, { force: true });
      await rename(backupPath, sourcePath);
      await rm(destinationPath, { recursive: true, force: true });
      throw linkError;
    }
  }
}

export async function importProjectDirectory(source: string, destination: string, mode: ProjectDirectoryImportMode): Promise<void> {
  const sourcePath = path.resolve(source);
  const destinationPath = path.resolve(destination);
  await assertImportPaths(sourcePath, destinationPath);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  if (mode === "copy") {
    await copyDirectory(sourcePath, destinationPath);
    return;
  }
  if (mode === "move") {
    await moveDirectory(sourcePath, destinationPath);
    return;
  }
  await moveDirectoryWithLink(sourcePath, destinationPath);
}

async function aliasTargetsSource(aliasPath: string | undefined, sourcePath: string): Promise<boolean> {
  if (!aliasPath) return false;
  try {
    if (!(await lstat(aliasPath)).isSymbolicLink()) return false;
    return await realpath(aliasPath) === await realpath(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Move a managed directory and preserve a proven move-link source alias. */
export async function relocateProjectDirectory(source: string, destination: string, alias?: string): Promise<void> {
  const sourcePath = path.resolve(source);
  const destinationPath = path.resolve(destination);
  const aliasPath = alias ? path.resolve(alias) : undefined;
  await assertImportPaths(sourcePath, destinationPath);
  const replaceAlias = await aliasTargetsSource(aliasPath, sourcePath);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await moveDirectory(sourcePath, destinationPath);
  if (!replaceAlias || !aliasPath) return;
  try {
    await rm(aliasPath);
    await symlink(destinationPath, aliasPath, "dir");
  } catch (error) {
    try {
      await moveDirectory(destinationPath, sourcePath);
      await rm(aliasPath, { force: true });
      await symlink(sourcePath, aliasPath, "dir");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Project relocation alias rollback failed");
    }
    throw error;
  }
}
