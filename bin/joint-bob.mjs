#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] ?? "help";

function run(script, cwd = packageRoot) {
  const result = spawnSync("bash", [script], { cwd, stdio: "inherit", env: process.env });
  process.exit(result.status ?? 1);
}

function install() {
  const installDir = process.env.JOINT_BOB_INSTALL_DIR ?? path.join(os.homedir(), ".local", "share", "joint-bob", "app");
  const staging = `${installDir}.staging-${process.pid}`;
  const backup = `${installDir}.backup-${process.pid}`;
  mkdirSync(path.dirname(installDir), { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  cpSync(packageRoot, staging, { recursive: true, filter: (source) => path.basename(source) !== "node_modules" });
  const releaseCommit = process.env.JOINT_BOB_RELEASE_COMMIT;
  if (releaseCommit) {
    if (!/^[0-9a-f]{40}$/i.test(releaseCommit)) throw new Error("JOINT_BOB_RELEASE_COMMIT must be a 40-character Git commit");
    writeFileSync(path.join(staging, ".joint-bob-release"), `commit=${releaseCommit}\n`);
  }
  if (existsSync(installDir)) renameSync(installDir, backup);
  try {
    renameSync(staging, installDir);
    const result = spawnSync("bash", [path.join(installDir, "scripts", "install-service.sh")], { cwd: installDir, stdio: "inherit", env: process.env });
    if (result.status !== 0) throw new Error(`Installation failed with status ${result.status ?? 1}`);
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    rmSync(installDir, { recursive: true, force: true });
    if (existsSync(backup)) renameSync(backup, installDir);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (command === "install") install();
else if (command === "doctor") run(path.join(packageRoot, "scripts", "check-prerequisites.sh"));
else if (command === "claude-event") {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const runtime = await import("../dist/claude-runtime.js");
  runtime.recordClaudeHookEvent(JSON.parse(input));
} else if (["help", "--help", "-h"].includes(command)) {
  console.log("Usage: joint-bob <install|doctor>");
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}
