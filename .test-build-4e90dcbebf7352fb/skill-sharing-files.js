import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveDataDirectory } from "./data-directory.js";
let pending = Promise.resolve();
function withSkillMutation(action) {
  const result = pending.then(action);
  pending = result.then(() => void 0, () => void 0);
  return result;
}
function marker(root, name, dataDir) {
  const key = createHash("sha256").update(`${path.resolve(root)}\0${name}`).digest("hex");
  return path.join(resolveDataDirectory(dataDir), "skill-removals", key);
}
async function skillSuppressed(root, name, dataDir) {
  try {
    await lstat(marker(root, name, dataDir));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function suppressSkill(root, name, dataDir) {
  const file = marker(root, name, dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ root, name }), { mode: 384 });
}
async function allowSkillImport(root, name, dataDir) {
  await rm(marker(root, name, dataDir), { force: true });
}
async function unlinkSkillAliases(destination, roots) {
  for (const root of roots) {
    const file = path.join(root, path.basename(destination));
    try {
      if ((await lstat(file)).isSymbolicLink() && path.resolve(path.dirname(file), await readlink(file)) === path.resolve(destination)) await unlink(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
async function backupRemovedSkill(destination, dataDir) {
  const backup = path.join(resolveDataDirectory(dataDir), "removed-skills", randomUUID(), path.basename(destination));
  await mkdir(path.dirname(backup), { recursive: true });
  await rename(destination, backup);
  return backup;
}
function receivedMarker(root, name, dataDir) {
  return `${marker(root, name, dataDir)}.received`;
}
async function markReceived(root, name, owner, dataDir) {
  const file = receivedMarker(root, name, dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, owner, { mode: 384 });
}
async function unmarkReceived(root, name, dataDir) {
  await rm(receivedMarker(root, name, dataDir), { force: true });
}
async function receivedOwner(root, name, dataDir) {
  try {
    return await readFile(receivedMarker(root, name, dataDir), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
export {
  allowSkillImport,
  backupRemovedSkill,
  markReceived,
  receivedOwner,
  skillSuppressed,
  suppressSkill,
  unlinkSkillAliases,
  unmarkReceived,
  withSkillMutation
};
