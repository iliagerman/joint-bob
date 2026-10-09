import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveDataDirectory } from "./data-directory.js";
function scopedSkillsRoot() {
  return path.join(resolveDataDirectory(), "scoped-skills");
}
function scopedSkillParent(name) {
  return path.join(scopedSkillsRoot(), name);
}
function scopedSkillDirectory(name) {
  return path.join(scopedSkillParent(name), name);
}
function indexFile() {
  return path.join(scopedSkillsRoot(), "index.json");
}
function writeScopedSkillIndex(entries) {
  mkdirSync(scopedSkillsRoot(), { recursive: true });
  const temporary = `${indexFile()}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(entries), { mode: 384 });
  renameSync(temporary, indexFile());
}
function readScopedSkillIndex() {
  try {
    return JSON.parse(readFileSync(indexFile(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
function scopedSkillRoots(projectId, conversationId) {
  if (!projectId) return [];
  return readScopedSkillIndex().filter((entry) => entry.projectIds.includes(projectId) || Boolean(conversationId) && entry.conversations.some((item) => item.projectId === projectId && item.conversationId === conversationId)).map((entry) => scopedSkillParent(entry.name));
}
export {
  readScopedSkillIndex,
  scopedSkillDirectory,
  scopedSkillParent,
  scopedSkillRoots,
  scopedSkillsRoot,
  writeScopedSkillIndex
};
