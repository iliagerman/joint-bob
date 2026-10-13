import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** A copy of the deployment watcher beside a stand-in installer, with its own home and a remote whose main is `commit`. */
function watcher(t: { after(run: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "jb-deploy-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), repo = path.join(root, "repo"), lock = path.join(home, ".joint-bob", "deploy.lock");
  mkdirSync(path.join(home, ".joint-bob"), { recursive: true });
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  copyFileSync("scripts/wait-for-main-and-deploy.sh", path.join(repo, "scripts", "wait-for-main-and-deploy.sh"));
  // Records who held the lock while it "installed".
  writeFileSync(path.join(repo, "scripts", "deploy-installed-nodes.sh"), `#!/usr/bin/env bash\ncut -d" " -f1 "$HOME/.joint-bob/deploy.lock/holder" >> "$HOME/installed.log"\necho $PPID >> "$HOME/installed.log"\n`);
  chmodSync(path.join(repo, "scripts", "deploy-installed-nodes.sh"), 0o755);
  const git = (...args: string[]) => { const result = spawnSync("git", ["-c", "init.defaultBranch=main", "-c", "user.email=test@example.invalid", "-c", "user.name=Test", "-C", repo, ...args], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "release");
  const commit = git("rev-parse", "HEAD");
  const run = () => spawnSync("bash", [path.join(repo, "scripts", "wait-for-main-and-deploy.sh"), commit, repo], { encoding: "utf8", env: { ...process.env, HOME: home, JOINT_BOB_DEPLOY_LOCK_WAIT_SECONDS: "2" } });
  const installs = () => existsSync(path.join(home, "installed.log")) ? readFileSync(path.join(home, "installed.log"), "utf8").trim().split("\n") : [];
  return { lock, run, installs, hold: (holder?: string) => { mkdirSync(lock); if (holder) writeFileSync(path.join(lock, "holder"), `${holder}\n`); } };
}

test("a deployment lock left by a deployment that was killed is taken over instead of blocking every later one", (t) => {
  const { lock, run, installs, hold } = watcher(t);
  const now = Math.floor(Date.now() / 1000);

  const free = run();
  assert.equal(free.status, 0, free.stderr);
  assert.equal(installs().length, 2);
  assert.equal(installs()[0], installs()[1], "the lock names the deployment that holds it");
  assert.equal(existsSync(lock), false, "and is released afterwards");

  // 2^31-1 is no process: the holder was killed without a chance to clean up.
  hold(`2147483647 ${now}`);
  const abandoned = run();
  assert.equal(abandoned.status, 0, abandoned.stderr);
  assert.match(abandoned.stdout, /Took over a deployment lock whose deployment is gone/);
  assert.equal(installs().length, 4);
  assert.equal(existsSync(lock), false);

  // Left by a version that did not label its lock: only its age can tell.
  hold();
  utimesSync(lock, new Date(Date.now() - 3 * 60 * 60_000), new Date(Date.now() - 3 * 60 * 60_000));
  assert.equal(run().status, 0);
  assert.equal(installs().length, 6);
});

test("a deployment lock that is in use is waited for and never cleared", (t) => {
  const { lock, run, installs, hold } = watcher(t);
  hold(`${process.pid} ${Math.floor(Date.now() / 1000)}`);
  const busy = run();
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /Could not acquire deployment lock/);
  assert.deepEqual(installs(), []);
  assert.equal(readFileSync(path.join(lock, "holder"), "utf8").split(" ")[0], String(process.pid), "the holder keeps its lock");

  // Taken a moment ago and not labelled yet: it belongs to a deployment that is starting.
  rmSync(lock, { recursive: true });
  hold();
  assert.equal(run().status, 1);
  assert.deepEqual(installs(), []);
  assert.equal(existsSync(lock), true);
});
