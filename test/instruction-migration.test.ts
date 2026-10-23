import assert from "node:assert/strict";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentInstructionFiles, globalInstructionsPath } from "../src/agent-instructions.js";
import { agentResourcePaths } from "../src/agent-resources.js";
import { resolveDataDirectory } from "../src/data-directory.js";
import { consolidateAgentInstructions } from "../src/instruction-migration.js";
import { settingsDatabase } from "../src/settings-store.js";
import { getSettings, updateSettings } from "../src/settings.js";

const root = path.join(os.homedir(), "instruction-migration");

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

test.before(() => { updateSettings({ syncthing: { endpoint: "" }, projects: { homePath: root } }); });
test.after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(path.join(resolveDataDirectory(), "instruction-backups"), { recursive: true, force: true });
});

test("instructions only one harness read move into the global AGENTS.md that every agent reads", async () => {
  const paths = agentResourcePaths();
  const claudeConfig = getSettings().claude.configPath;
  await write(path.join(paths.claudeInstructions, "CLAUDE.md"), "# Global Claude Guidelines\nRead the flow first.");
  await write(path.join(paths.claudeInstructions, "rules", "backend.md"), "Keep handlers thin.");
  await write(path.join(paths.piInstructions, "AGENTS.md"), "Use conventional commits.");
  await write(path.join(paths.commonInstructions, "rules", "shared.md"), "Answer briefly.");
  await write(globalInstructionsPath(paths), "Existing global words.\n");
  // What the old import left in Claude's own config: links into the managed copies.
  await mkdir(path.join(claudeConfig, "rules"), { recursive: true });
  await symlink(path.join(paths.claudeInstructions, "CLAUDE.md"), path.join(claudeConfig, "CLAUDE.md"));
  await symlink(path.join(paths.claudeInstructions, "rules", "backend.md"), path.join(claudeConfig, "rules", "backend.md"));
  assert.equal(agentInstructionFiles(paths, "kiro").some((file) => file.content.includes("Keep handlers thin")), false, "before: Kiro never saw Claude's rules");

  assert.equal(consolidateAgentInstructions("node-a", paths), 4);
  const global = await readFile(globalInstructionsPath(paths), "utf8");
  assert.equal(global, [
    "Existing global words.",
    "## claude/CLAUDE.md (formerly read by Claude only)\n\n# Global Claude Guidelines\nRead the flow first.",
    "## claude/rules/backend.md (formerly read by Claude only)\n\nKeep handlers thin.",
    "## pi/AGENTS.md (formerly read by Pi only)\n\nUse conventional commits.",
    "## common/rules/shared.md\n\nAnswer briefly.",
  ].join("\n\n") + "\n");
  for (const harness of ["claude", "pi", "kiro"] as const) {
    const files = agentInstructionFiles(paths, harness);
    assert.deepEqual(files.map((file) => file.label), ["Global instructions (AGENTS.md)"], `${harness} reads one set of instructions`);
  }
  const queued = settingsDatabase().prepare("SELECT payload FROM replication_outbox WHERE entity_type = 'instructions.global' ORDER BY created_at DESC LIMIT 1").get() as { payload: string };
  assert.equal(JSON.parse(queued.payload).content, global, "the merged file goes to this person's other machines");

  // Claude outside the app keeps its own copies.
  assert.equal(lstatSync(path.join(claudeConfig, "CLAUDE.md")).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(claudeConfig, "CLAUDE.md"), "utf8"), "# Global Claude Guidelines\nRead the flow first.");
  assert.equal(await readFile(path.join(claudeConfig, "rules", "backend.md"), "utf8"), "Keep handlers thin.");
  const [backup] = await readdir(path.join(resolveDataDirectory(), "instruction-backups"));
  assert.equal(await readFile(path.join(resolveDataDirectory(), "instruction-backups", backup, "pi", "AGENTS.md"), "utf8"), "Use conventional commits.");

  assert.equal(consolidateAgentInstructions("node-a", paths), 0, "nothing is left to move");
  assert.equal(await readFile(globalInstructionsPath(paths), "utf8"), global);

  // Text the file already has (a twin sent it first) is not added twice; too much is never half-moved.
  await write(path.join(paths.piInstructions, "AGENTS.md"), "Use conventional commits.");
  assert.equal(consolidateAgentInstructions("node-a", paths), 1);
  assert.equal(await readFile(globalInstructionsPath(paths), "utf8"), global);
  await write(path.join(paths.claudeInstructions, "huge.md"), "x".repeat(300 * 1024));
  assert.equal(consolidateAgentInstructions("node-a", paths), 0);
  assert.ok(existsSync(path.join(paths.claudeInstructions, "huge.md")));
  await rm(path.join(paths.claudeInstructions, "huge.md"));
  await rm(path.join(claudeConfig, "CLAUDE.md"));
  await rm(path.join(claudeConfig, "rules"), { recursive: true });
});
