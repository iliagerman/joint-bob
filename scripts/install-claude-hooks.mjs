#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const [nodeBin, repoRoot, stateDir] = process.argv.slice(2);
if (!nodeBin || !repoRoot || !stateDir) throw new Error("Usage: install-claude-hooks NODE_BIN REPO_ROOT STATE_DIR");

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const settingsPath = path.join(configDir, "settings.json");
let settings = {};
try {
  settings = JSON.parse(readFileSync(settingsPath, "utf8"));
} catch (error) {
  if (error && typeof error === "object" && error.code === "ENOENT") settings = {};
  else throw error;
}
if (typeof settings !== "object" || settings === null || Array.isArray(settings)) throw new Error("Claude settings root must be an object");
const root = settings;
if (root.hooks !== undefined && (typeof root.hooks !== "object" || root.hooks === null || Array.isArray(root.hooks))) throw new Error("Claude settings hooks must be an object");
const hooks = root.hooks ?? {};
const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "StopFailure", "SessionEnd"];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const command = `JOINT_BOB_DATA_DIR=${quote(stateDir)} ${quote(nodeBin)} ${quote(path.join(repoRoot, "bin", "joint-bob.mjs"))} claude-event`;

for (const event of events) {
  const entries = hooks[event] ?? [];
  if (!Array.isArray(entries)) throw new Error(`Claude settings hooks.${event} must be an array`);
  hooks[event] = entries
    .map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry) || !Array.isArray(entry.hooks)) return { entry, remove: false };
      const filteredHooks = entry.hooks.filter((hook) => !(typeof hook === "object" && hook !== null && typeof hook.command === "string" && hook.command.includes("joint-bob.mjs") && hook.command.includes("claude-event")));
      const removedManagedHook = filteredHooks.length !== entry.hooks.length;
      return { entry: { ...entry, hooks: filteredHooks }, remove: removedManagedHook && filteredHooks.length === 0 };
    })
    .filter(({ remove }) => !remove)
    .map(({ entry }) => entry);
  const entry = { hooks: [{ type: "command", command }] };
  if (event === "PreToolUse" || event === "PostToolUse") Object.assign(entry, { matcher: "" });
  hooks[event].push(entry);
}
root.hooks = hooks;
mkdirSync(configDir, { recursive: true, mode: 0o700 });
const temporary = path.join(configDir, `.settings.json.${process.pid}.tmp`);
writeFileSync(temporary, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
renameSync(temporary, settingsPath);
chmodSync(settingsPath, 0o600);
