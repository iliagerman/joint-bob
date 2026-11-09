#!/usr/bin/env node
// Copies published assets, never private source refs, into the legacy update repository.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const assetNames = ["joint-bob.tar.gz", "joint-bob.tar.gz.sha256"];

function gh(args, token, allowMissing = false) {
  const result = spawnSync("gh", args, { env: { ...process.env, GH_TOKEN: token }, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowMissing && /\(HTTP 404\)/.test(result.stderr)) return null;
    throw new Error(`Release mirror command failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function release(repository, tag, token, allowMissing = false) {
  const json = gh(["api", `repos/${repository}/releases/tags/${tag}`], token, allowMissing);
  return json === null ? null : JSON.parse(json);
}

async function download(repository, tag, name, directory, token) {
  await mkdir(directory, { recursive: true });
  gh(["release", "download", tag, "--repo", repository, "--pattern", name, "--dir", directory], token);
  return readFile(path.join(directory, name));
}

export async function mirrorRelease({ sourceRepository, targetRepository, tag, sourceToken, targetToken }) {
  for (const repo of [sourceRepository, targetRepository]) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Invalid release repository");
  }
  if (sourceRepository === targetRepository || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("Invalid release mirror target");
  if (!sourceToken || !targetToken) throw new Error("Both release publishing credentials are required");
  const source = release(sourceRepository, tag, sourceToken);
  if (source.draft || source.prerelease || !assetNames.every(name => source.assets.some(asset => asset.name === name))) {
    throw new Error("Source release is not fully published");
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-release-mirror-"));
  try {
    const sourceDir = path.join(root, "source");
    const archive = await download(sourceRepository, tag, assetNames[0], sourceDir, sourceToken);
    const checksum = await download(sourceRepository, tag, assetNames[1], sourceDir, sourceToken);
    if (createHash("sha256").update(archive).digest("hex") !== checksum.toString("utf8").trim().split(/\s+/)[0]) {
      throw new Error("Source release checksum mismatch");
    }
    let target = release(targetRepository, tag, targetToken, true);
    if (!target) {
      // The old repository does not contain the new private commit. Its release tag
      // points at its own main; the downloaded package carries the real commit marker.
      gh(["release", "create", tag, "--repo", targetRepository, "--target", "main", "--draft", "--title", `Joint Bob ${tag}`, "--notes", "Compatibility release for existing installations. Configure a machine-local GitHub update token before private-only updates."], targetToken);
      target = { assets: [], draft: true };
    }
    for (const name of assetNames) {
      if (target.assets.some(asset => asset.name === name)) {
        const existing = await download(targetRepository, tag, name, path.join(root, "target"), targetToken);
        if (!existing.equals(await readFile(path.join(sourceDir, name)))) throw new Error(`Mirror already contains different bytes for ${name}; refusing to overwrite`);
      } else gh(["release", "upload", tag, path.join(sourceDir, name), "--repo", targetRepository], targetToken);
    }
    if (target.draft) gh(["release", "edit", tag, "--repo", targetRepository, "--draft=false", "--latest"], targetToken);
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { version } = JSON.parse(await readFile("package.json", "utf8"));
    await mirrorRelease({ sourceRepository: process.env.GITHUB_REPOSITORY, targetRepository: process.env.LEGACY_RELEASE_REPOSITORY,
      tag: `v${version}`, sourceToken: process.env.GH_TOKEN, targetToken: process.env.LEGACY_RELEASE_TOKEN });
    console.log(`Verified release mirror v${version}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
