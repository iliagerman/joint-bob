import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "installer-safety-"));
  const source = path.join(root, "source");
  const app = path.join(root, "app");
  await mkdir(path.join(source, "bin"), { recursive: true });
  await mkdir(path.join(source, "scripts"));
  await mkdir(path.join(app, "scripts"), { recursive: true });
  await cp("bin/joint-bob.mjs", path.join(source, "bin/joint-bob.mjs"));
  await writeFile(path.join(app, "old"), "old");
  await writeFile(path.join(app, "scripts/install-service.sh"), '#!/bin/bash\necho "$1" >> "$LOG"\n[ "$1" = --restart-only ]\n');
  const env = { ...process.env, JOINT_BOB_INSTALL_DIR: app, LOG: path.join(root, "log") };
  return { root, source, app, env };
}

function install(f: Awaited<ReturnType<typeof fixture>>) {
  const child = spawn(process.execPath, [path.join(f.source, "bin/joint-bob.mjs"), "install"], { env: f.env, stdio: "ignore", detached: true });
  const done = new Promise<number | null>((resolve) => child.on("close", resolve));
  return { child, done };
}

async function marker(file: string) {
  for (let i = 0; i < 300; i++) {
    try { return await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Missing marker: ${file}`);
}

test("failed activation restores files and restarts without reinstalling dependencies", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, "scripts/install-service.sh"), '#!/bin/bash\n[ "$1" = --restart-only ] && { echo "$1" >> "$LOG"; exit 0; }\n[[ "$1" = --build-only || "$1" = --prepare-only ]] && exit 0\nexit 7\n');
    assert.notEqual(await install(f).done, 0);
    assert.equal(await readFile(path.join(f.app, "old"), "utf8"), "old");
    assert.equal(await readFile(f.env.LOG, "utf8"), "--restart-only\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("TERM during activation restores prior files and service", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, "scripts/install-service.sh"), '#!/bin/bash\n[ "$1" = --restart-only ] && { echo "$1" >> "$LOG"; exit 0; }\n[[ "$1" = --build-only || "$1" = --prepare-only ]] && exit 0\necho ready > "$LOG.ready"\nsleep 30\n');
    const run = install(f);
    await marker(`${f.env.LOG}.ready`);
    run.child.kill("SIGTERM");
    assert.notEqual(await run.done, 0);
    assert.equal(await readFile(path.join(f.app, "old"), "utf8"), "old");
    assert.equal(await readFile(f.env.LOG, "utf8"), "--restart-only\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("install lock covers build children after installer is killed and releases afterward", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, "scripts/install-service.sh"), '#!/bin/bash\necho "$1" >> "$LOG"\nif [ "$1" = --build-only ]; then\n echo $PPID > "$LOG.pid"\n sleep 2\nfi\n');
    const first = install(f);
    const workerPid = Number(await marker(`${f.env.LOG}.pid`));
    process.kill(workerPid, "SIGKILL");
    await first.done;
    const second = install(f);
    assert.notEqual(await second.done, 0, "second installer must reject overlap with orphaned build");
    await new Promise((resolve) => setTimeout(resolve, 2300));
    assert.equal(await install(f).done, 0, "OS must release lock after killed install's children finish");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("missing Perl fails explicitly before replacing files", async () => {
  const f = await fixture();
  try {
    await assert.rejects(execFileAsync(process.execPath, [path.join(f.source, "bin/joint-bob.mjs"), "install"], {
      env: { ...f.env, PATH: f.root },
    }), (error: unknown) => {
      assert.match((error as Error & { stderr: string }).stderr, /Perl is required/);
      return true;
    });
    assert.equal(await readFile(path.join(f.app, "old"), "utf8"), "old");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("refused preparation never swaps files or restarts the running service", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, "scripts/install-service.sh"), '#!/bin/bash\necho "$1" >> "$LOG"\n[ "$1" = --build-only ] && exit 0\n[ "$1" = --prepare-only ] && { cat "$JOINT_BOB_INSTALL_DIR/old" >> "$LOG"; exit 9; }\nexit 7\n');
    assert.notEqual(await install(f).done, 0);
    assert.equal(await readFile(path.join(f.app, "old"), "utf8"), "old");
    assert.equal(await readFile(f.env.LOG, "utf8"), "--build-only\n--prepare-only\nold");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("failed build leaves the running installation untouched", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, "scripts/install-service.sh"), '#!/bin/bash\ncat "$JOINT_BOB_INSTALL_DIR/old" > "$LOG"\nexit 9\n');
    assert.notEqual(await install(f).done, 0);
    assert.equal(await readFile(f.env.LOG, "utf8"), "old");
    assert.equal(await readFile(path.join(f.app, "old"), "utf8"), "old");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("cleanup errors cannot prevent atomic rollback or restart", async () => {
  const f = await fixture();
  try {
    const fault = path.join(f.root, "fault.mjs");
    await writeFile(fault, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const rm = fs.rmSync;
fs.rmSync = (p, opts) => { if (String(p) === process.env.JOINT_BOB_INSTALL_DIR || String(p).includes('.failed-')) throw new Error('injected cleanup failure'); return rm(p, opts); };
syncBuiltinESMExports();`);
    await writeFile(path.join(f.source, "scripts/install-service.sh"), '#!/bin/bash\n[[ "$1" = --build-only || "$1" = --prepare-only ]] && exit 0\n[ "$1" = --restart-only ] && { echo restarted > "$LOG"; exit 0; }\nexit 7\n');
    const result = await execFileAsync(process.execPath, [path.join(f.source, "bin/joint-bob.mjs"), "install"], {
      env: { ...f.env, NODE_OPTIONS: `--import=${fault}` },
    }).catch((error: Error & { stderr: string }) => error);
    assert.ok(result instanceof Error);
    assert.equal(await readFile(path.join(f.app, "old"), "utf8"), "old");
    assert.equal(await readFile(f.env.LOG, "utf8"), "restarted\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("failed rollback restart retains candidate dependencies", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, "scripts/install-service.sh"), '#!/bin/bash\nif [ "$1" = --build-only ]; then mkdir node_modules; echo live-dependency > node_modules/live; exit 0; fi\n[ "$1" = --prepare-only ] && exit 0\nexit 7\n');
    assert.notEqual(await install(f).done, 0);
    assert.equal(await readFile(path.join(f.app, "old"), "utf8"), "old");
    const candidates = (await readdir(f.root)).filter((entry) => entry.startsWith("app.failed-"));
    assert.equal(candidates.length, 1, "failed restart must retain the candidate directory");
    assert.equal(await readFile(path.join(f.root, candidates[0], "node_modules/live"), "utf8"), "live-dependency\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const succeedsAt of [3, 6]) {
  test(`macOS rollback bootstrap ${succeedsAt === 3 ? "retries transient failure" : "stops after five attempts"}`, async () => {
    const f = await fixture();
    try {
      const bin = path.join(f.root, "tools");
      await mkdir(bin);
      await writeFile(path.join(bin, "uname"), '#!/bin/bash\necho Darwin\n', { mode: 0o755 });
      await writeFile(path.join(bin, "sleep"), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
      await writeFile(path.join(bin, "launchctl"), `#!/bin/bash
echo "$*" >> "$LOG"
if [ "$1" = bootstrap ]; then
  count=0
  if [ -f "$LOG.count" ]; then read -r count < "$LOG.count"; fi
  count=$((count + 1))
  echo "$count" > "$LOG.count"
  [ "$count" -ge "$SUCCEEDS_AT" ] || exit 1
fi
`, { mode: 0o755 });
      const restart = execFileAsync("bash", [path.resolve("scripts/install-service.sh"), "--restart-only"], {
        env: { ...f.env, HOME: f.root, JOINT_BOB_DATA_DIR: path.join(f.root, "state"), PATH: `${bin}:${process.env.PATH}`, SUCCEEDS_AT: String(succeedsAt) },
      });
      if (succeedsAt === 3) await restart;
      else await assert.rejects(restart);
      assert.equal(await readFile(`${f.env.LOG}.count`, "utf8"), `${Math.min(succeedsAt, 5)}\n`);
      const log = await readFile(f.env.LOG, "utf8");
      if (succeedsAt === 3) assert.match(log, /kickstart -k/);
      else assert.doesNotMatch(log, /kickstart/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test("native rollback restart never invokes npm on Linux or macOS", async () => {
  const f = await fixture();
  try {
    const bin = path.join(f.root, "tools");
    await mkdir(bin);
    for (const tool of ["systemctl", "launchctl", "npm"]) {
      await writeFile(path.join(bin, tool), `#!/bin/bash\necho '${tool}' \"$@\" >> \"$LOG\"\n`, { mode: 0o755 });
    }
    await writeFile(path.join(bin, "uname"), '#!/bin/bash\necho "$TEST_PLATFORM"\n', { mode: 0o755 });
    for (const platform of ["Linux", "Darwin"]) {
      await execFileAsync("bash", [path.resolve("scripts/install-service.sh"), "--restart-only"], {
        env: { ...f.env, HOME: f.root, JOINT_BOB_DATA_DIR: path.join(f.root, "state"), PATH: `${bin}:${process.env.PATH}`, TEST_PLATFORM: platform },
      });
    }
    const log = await readFile(f.env.LOG, "utf8");
    assert.match(log, /systemctl --user restart joint-bob.service/);
    assert.match(log, /launchctl bootstrap gui\/\d+ .*com.joint-bob.node.plist/);
    assert.match(log, /launchctl kickstart -k gui\/\d+\/com.joint-bob.node/);
    assert.doesNotMatch(log, /npm/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("direct service installer shares the CLI lock", async () => {
  const f = await fixture();
  let run: ReturnType<typeof install> | undefined;
  try {
    await writeFile(path.join(f.source, "scripts/install-service.sh"), '#!/bin/bash\necho ready > "$LOG"\nsleep 30\n');
    run = install(f);
    await marker(f.env.LOG);
    const entry = path.join(f.root, "direct");
    await mkdir(path.join(entry, "scripts"), { recursive: true });
    await mkdir(path.join(entry, "bin"));
    await cp("scripts/install-service.sh", path.join(entry, "scripts/install-service.sh"));
    await cp("bin/joint-bob.mjs", path.join(entry, "bin/joint-bob.mjs"));
    await writeFile(path.join(entry, "scripts/install-node-runtime.sh"), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    await assert.rejects(execFileAsync("bash", [path.join(entry, "scripts/install-service.sh")], { env: f.env }), (error: unknown) => {
      assert.match((error as Error & { stderr: string }).stderr, /Another installation is running/);
      return true;
    });
  } finally {
    if (run) { run.child.kill("SIGTERM"); await run.done; }
    await rm(f.root, { recursive: true, force: true });
  }
});
