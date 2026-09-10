#!/usr/bin/env node
// Called inside the per-version release lock, so a retry sees the previous run's
// published assets before deciding whether it may publish anything again.
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";

async function prepareRelease() {
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("package.json must contain a semantic release version");
  const tag = `v${version}`;
  if (!["refs/heads/main", `refs/tags/${tag}`].includes(process.env.GITHUB_REF)) {
    throw new Error(`Release ref must be main or ${tag}`);
  }
  const changelog = await readFile("CHANGELOG.md", "utf8");
  const latest = changelog.split(/^## /m)[1] ?? "";
  if (latest.match(/^(\d+\.\d+\.\d+)(?:\s|$)/)?.[1] !== version || !/^[-*][ \t]+\S/m.test(latest) || /^## Unreleased\s*$/m.test(changelog)) {
    throw new Error(`CHANGELOG.md must start with release notes for ${version} and contain no Unreleased section`);
  }
  const { GITHUB_OUTPUT: output, GITHUB_REPOSITORY: repository, GITHUB_SHA: commit } = process.env;
  if (!output || !repository || !/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("Missing GitHub Actions release context");
  if (process.argv.includes("--metadata-only")) {
    await appendFile(output, `tag=${tag}\n`);
    return;
  }

  const api = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const response = await fetch(`${api}/repos/${repository}/releases/tags/${tag}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.GH_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok && response.status !== 404) throw new Error(`GitHub release lookup failed: HTTP ${response.status}`);
  if (response.ok) {
    const release = await response.json();
    const requiredAssets = ["joint-bob.tar.gz", "joint-bob.tar.gz.sha256"];
    if (!release.draft && !release.prerelease && requiredAssets.every((name) => release.assets?.some((asset) => asset.name === name && asset.state === "uploaded"))) {
      // A docs-only push may reuse the version; an application push may not.
      execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", `refs/tags/${tag}`], { stdio: "pipe" });
      const changed = execFileSync("git", ["diff", "--name-only", "FETCH_HEAD", commit, "--", "src", "public", "bin"], { encoding: "utf8" });
      if (changed.trim()) throw new Error(`Application changed since ${tag}; bump the version`);
      console.log(`${tag} is already published; nothing to release`);
      await appendFile(output, `tag=${tag}\npublish=false\n`);
      return;
    }
  }

  // Never retarget an existing tag or attach a different commit's archive to it.
  // Annotated tags have a peeled ^{} entry containing the commit rather than the tag object.
  const refs = execFileSync("git", ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((line) => line.split(/\s+/));
  const existing = refs.find(([, ref]) => ref.endsWith("^{}")) ?? refs[0];
  if (existing && existing[0] !== commit) throw new Error(`${tag} already points to a different commit; bump the version instead`);
  await appendFile(output, `tag=${tag}\npublish=true\n`);
}

prepareRelease().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
