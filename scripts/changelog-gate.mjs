#!/usr/bin/env node
// Blocks a push to main until the commits being pushed are described in
// CHANGELOG.md under a bumped package.json version. When they are not, Claude
// (Haiku) writes both files here in the working tree and the push is refused,
// so the release notes land in a commit rather than behind the release.
import { execFileSync, spawnSync } from "node:child_process";

const [baseSha, localSha] = process.argv.slice(2).filter((argument) => argument !== "--check");
// --check reports without calling Claude, for tests and CI.
const checkOnly = process.argv.includes("--check");
const base = /^0+$/.test(baseSha) ? null : baseSha;
const headingPattern = /^##[ \t]+(\d+\.\d+\.\d+)/m;
const unreleasedPattern = /^##[ \t]+Unreleased[ \t]*$/m;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function fileAt(commit, file) {
  return git("show", `${commit}:${file}`);
}

function isNewerVersion(candidate, baseline) {
  const left = candidate.split(".").map(Number);
  const right = baseline.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

/** The version at the top of a changelog, and whether it lists anything. */
function latestRelease(changelog) {
  const heading = headingPattern.exec(changelog);
  if (!heading) return null;
  const body = changelog.slice(heading.index + heading[0].length);
  const next = headingPattern.exec(body);
  const section = next ? body.slice(0, next.index) : body;
  return { version: heading[1], described: /^[-*][ \t]+\S/m.test(section) };
}

function blockThePush(reason) {
  console.error(`\nChangelog gate: ${reason}`);
  if (checkOnly) {
    console.error("Push blocked.\n");
    process.exit(1);
  }
  const commits = base ? git("log", "--format=- %s%n%b", `${base}..${localSha}`) : git("log", "--format=- %s%n%b", "-1", localSha);
  const changed = base ? git("diff", "--stat", base, localSha) : git("show", "--stat", "--format=", localSha);
  const version = JSON.parse(fileAt(localSha, "package.json")).version;

  console.error("Asking Claude (haiku) to write the release notes...\n");

  const prompt = [
    "You are writing the release notes for Joint Bob before a push to main.",
    "",
    `The version currently in package.json is ${version}.`,
    "",
    "Commits about to be pushed:",
    commits.trim(),
    "",
    "Files changed:",
    changed.trim(),
    "",
    "Do exactly two things:",
    "1. Pick the next semantic version from those commits: a breaking change bumps major, any new feature bumps minor, otherwise bump patch. Write it into the `version` field of package.json.",
    "2. Review every bullet under `## Unreleased` against the pushed commits and changed files. Replace that section with one coherent version section directly above the newest existing version section:",
    "",
    `## <the version you chose> — ${new Date().toISOString().slice(0, 10)}`,
    "",
    "- <one short past-tense sentence per user-visible change>",
    "",
    "Rules:",
    "- Write for someone using the app, not for a developer reading commits. No commit prefixes like `feat(ui):`, no file names, no commit hashes.",
    "- One bullet per user-visible change; merge related commit entries into a single bullet.",
    "- Preserve user-visible changes represented by the full push range, not only the last commit.",
    "- Leave out pure refactors, test-only changes, and dependency bumps.",
    "- At most 12 bullets.",
    "- Change nothing else in either file, and do not commit anything.",
  ].join("\n");

  const claude = spawnSync("claude", [
    "-p", prompt,
    "--model", "haiku",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read Edit Write",
  ], { stdio: ["ignore", "inherit", "inherit"] });

  if (claude.error || claude.status !== 0) {
    console.error("\nClaude could not write the release notes. Update package.json and CHANGELOG.md by hand.");
  } else {
    console.error("\nClaude updated package.json and CHANGELOG.md. Review them, commit, and push again.");
  }
  console.error("Push blocked.\n");
  process.exit(1);
}

const changed = (base ? git("diff", "--name-only", base, localSha) : git("show", "--name-only", "--format=", localSha)).split("\n").filter(Boolean);
// Only shipped application code earns a release note; docs and tooling do not.
if (!changed.some((file) => /^(src|public|bin)\//.test(file))) process.exit(0);

const pushedVersion = JSON.parse(fileAt(localSha, "package.json")).version;
const baseVersion = base ? JSON.parse(fileAt(base, "package.json")).version : null;
if (baseVersion && !isNewerVersion(pushedVersion, baseVersion)) blockThePush(`package.json is still ${pushedVersion}; every deployment needs its own version.`);

const changelog = fileAt(localSha, "CHANGELOG.md");
if (unreleasedPattern.test(changelog)) blockThePush("CHANGELOG.md still has Unreleased commit entries that need review.");
const release = latestRelease(changelog);
if (!release) blockThePush("CHANGELOG.md has no version sections.");
if (release.version !== pushedVersion) blockThePush(`CHANGELOG.md documents ${release.version} but package.json says ${pushedVersion}.`);
if (!release.described) blockThePush(`CHANGELOG.md lists no changes under ${pushedVersion}.`);
