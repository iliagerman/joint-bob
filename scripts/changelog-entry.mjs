#!/usr/bin/env node
// Adds one staged application change to the Unreleased changelog section before
// Git creates the commit. The pre-push gate later rewrites these entries into
// coherent release notes for the full push range.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function unreleasedBulletCount(changelog) {
  const start = changelog.search(/^## Unreleased\s*$/m);
  if (start < 0) return 0;
  const following = changelog.slice(start + "## Unreleased".length);
  const end = following.search(/^## /m);
  const section = end < 0 ? following : following.slice(0, end);
  return section.match(/^[-*][ \t]+\S/gm)?.length ?? 0;
}

const changed = git("diff", "--cached", "--name-only").split("\n").filter(Boolean);
if (!changed.some((file) => /^(src|public|bin)\//.test(file))) process.exit(0);

const previousBulletCount = unreleasedBulletCount(readFileSync("CHANGELOG.md", "utf8"));
const summary = git("diff", "--cached", "--stat").trim();
const diff = git("diff", "--cached", "--unified=1").slice(0, 120_000).trim();
const prompt = [
  "Add one entry for the currently staged Joint Bob change to CHANGELOG.md.",
  "",
  "If CHANGELOG.md has no `## Unreleased` section, insert one directly above the newest version section.",
  "Add exactly one short past-tense bullet under `## Unreleased` describing this commit's effect.",
  "Write for the person using or operating the app. Do not use commit prefixes, file names, or implementation detail.",
  "Do not merge or rewrite older Unreleased bullets. Change only CHANGELOG.md. Do not stage or commit anything.",
  "",
  "Staged files:",
  summary,
  "",
  "Staged diff:",
  diff,
].join("\n");

const claude = spawnSync("claude", [
  "-p", prompt,
  "--model", "haiku",
  "--permission-mode", "acceptEdits",
  "--allowedTools", "Read Edit",
], { stdio: ["ignore", "inherit", "inherit"] });

if (claude.error || claude.status !== 0) {
  console.error("pre-commit: Claude could not add the Unreleased changelog entry.");
  process.exit(1);
}
if (unreleasedBulletCount(readFileSync("CHANGELOG.md", "utf8")) !== previousBulletCount + 1) {
  console.error("pre-commit: Claude did not add exactly one `## Unreleased` bullet.");
  process.exit(1);
}
git("add", "CHANGELOG.md");
