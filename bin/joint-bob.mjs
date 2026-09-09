#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] ?? "help";
let activeChild;
let interrupted = false;

function run(script, cwd = packageRoot) {
  const result = spawnSync("bash", [script], { cwd, stdio: "inherit", env: process.env });
  process.exit(result.status ?? 1);
}

function execute(executable, args, cwd, locked = false) {
  return new Promise((resolve, reject) => {
    activeChild = spawn(executable, args, { cwd, stdio: locked ? ["inherit", "inherit", "inherit", 3] : "inherit", detached: true });
    activeChild.once("error", reject);
    activeChild.once("close", (code) => { activeChild = undefined; resolve(code ?? 1); });
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = true;
    if (activeChild) process.kill(-activeChild.pid, signal);
  });
}

function cleanup(directory) {
  try { rmSync(directory, { recursive: true, force: true }); }
  catch (error) { console.error(`Could not clean ${directory}: ${error.message}`); }
}

async function replaceInstallation(installDir) {
  const staging = `${installDir}.staging-${process.pid}`;
  const backup = `${installDir}.backup-${process.pid}`;
  const failed = `${installDir}.failed-${process.pid}`;
  let swapped = false;
  try {
    cpSync(packageRoot, staging, { recursive: true, filter: (source) => path.basename(source) !== "node_modules" });
    const releaseCommit = process.env.JOINT_BOB_RELEASE_COMMIT;
    if (releaseCommit) {
      if (!/^[0-9a-f]{40}$/i.test(releaseCommit)) throw new Error("JOINT_BOB_RELEASE_COMMIT must be a 40-character Git commit");
      writeFileSync(path.join(staging, ".joint-bob-release"), `commit=${releaseCommit}\n`);
    }
    const build = await execute("bash", [path.join(staging, "scripts/install-service.sh"), "--build-only"], staging, true);
    if (build !== 0 || interrupted) throw new Error(`Installation build failed with status ${build}`);
    if (existsSync(installDir)) renameSync(installDir, backup);
    swapped = true;
    renameSync(staging, installDir);
    const result = await execute("bash", [path.join(installDir, "scripts/install-service.sh"), "--activate-only"], installDir, true);
    if (result !== 0 || interrupted) throw new Error(`Installation failed with status ${result}`);
  } catch (error) {
    interrupted = true;
    if (swapped) {
      if (existsSync(installDir)) renameSync(installDir, failed);
      if (existsSync(backup)) {
        renameSync(backup, installDir);
        // Use the new restart implementation, not a legacy installer that runs npm ci.
        const restartScript = path.join(existsSync(failed) ? failed : staging, "scripts/install-service.sh");
        const restored = await execute("bash", [restartScript, "--restart-only"], installDir, true);
        if (restored !== 0) console.error(`Could not restart the restored installation; retaining ${failed}`);
        else cleanup(failed);
      }
    }
    throw error;
  } finally {
    cleanup(staging);
  }
  cleanup(backup);
}

async function install() {
  const requested = path.resolve(process.env.JOINT_BOB_INSTALL_DIR ?? path.join(os.homedir(), ".local", "share", "joint-bob", "app"));
  mkdirSync(path.dirname(requested), { recursive: true });
  const installDir = existsSync(requested) ? realpathSync(requested) : path.join(realpathSync(path.dirname(requested)), path.basename(requested));
  if (process.argv[3] === "--locked") return replaceInstallation(installDir);
  // flock is kernel-owned and survives in children via fd 3; never unlink the lock inode.
  const lock = 'use Fcntl qw(:flock); use POSIX (); $^F = 3; open(my $lock, ">>", shift @ARGV) or die "open install lock: $!"; flock($lock, LOCK_EX|LOCK_NB) or die "Another installation is running\\n"; POSIX::dup2(fileno($lock), 3) >= 0 or die "dup lock: $!"; $^F = 3; exec @ARGV or die "exec installer: $!";';
  try {
    process.exitCode = await execute("perl", ["-e", lock, `${installDir}.install.lock`, process.execPath, fileURLToPath(import.meta.url), "install", "--locked"], packageRoot);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Perl is required for cross-platform installer locking");
    throw error;
  }
}

if (command === "install") {
  try { await install(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
} else if (command === "doctor") run(path.join(packageRoot, "scripts", "check-prerequisites.sh"));
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
