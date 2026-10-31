import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveDataDirectory } from "./data-directory.js";
import { GIT_STORY_TTL_MS } from "./git-review-threads.js";
import type { StoryScript } from "./story-script-schema.js";

// A story's podcast is kept beside its saved story and goes with it: after GIT_STORY_TTL_MS the script and every line
// that was spoken for it are deleted.

const scriptsDirectory = () => path.join(resolveDataDirectory(), "story-scripts");
export const storyVoiceDirectory = () => path.join(resolveDataDirectory(), "story-voice");

const scriptFile = (projectId: string, threadId: string) =>
  path.join(scriptsDirectory(), `${createHash("sha256").update(`${projectId}\n${threadId}`).digest("hex")}.json`);

function readFile(file: string): string | null {
  try { return readFileSync(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The saved script of a story, or null when there is none or its story has expired. */
export function loadStoryScript(projectId: string, threadId: string, now = Date.now()): StoryScript | null {
  const file = scriptFile(projectId, threadId);
  const text = readFile(file);
  if (text === null) return null;
  const script = JSON.parse(text) as StoryScript;
  if (Date.parse(script.expiresAt) <= now) { rmSync(file, { force: true }); return null; }
  return script;
}

export function saveStoryScript(projectId: string, threadId: string, script: StoryScript): StoryScript {
  mkdirSync(scriptsDirectory(), { recursive: true });
  writeFileSync(scriptFile(projectId, threadId), JSON.stringify(script));
  return script;
}

function names(directory: string): string[] {
  try { return readdirSync(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const PRUNE_EVERY_MS = 60 * 60_000;
let lastPrune = 0;

/** Deletes expired scripts and spoken lines older than a story lives. Looked at most once an hour, when a story is touched. */
export function pruneStoryFiles(now = Date.now()): void {
  if (now - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = now;
  for (const name of names(scriptsDirectory())) {
    const file = path.join(scriptsDirectory(), name);
    const text = readFile(file);
    if (text !== null && Date.parse((JSON.parse(text) as StoryScript).expiresAt) <= now) rmSync(file, { force: true });
  }
  for (const name of names(storyVoiceDirectory())) {
    const file = path.join(storyVoiceDirectory(), name);
    if (now - statSync(file).mtimeMs > GIT_STORY_TTL_MS) rmSync(file, { force: true });
  }
}

/** For tests: lets the next prune run at once. */
export function resetStoryPruneClock(): void { lastPrune = 0; }
