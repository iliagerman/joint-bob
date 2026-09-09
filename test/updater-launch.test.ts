import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const release = { version: "99.0.0", tag: "v99.0.0", archiveUrl: "https://example.invalid/archive", checksumUrl: "https://example.invalid/checksum", publishedAt: null, htmlUrl: null };

for (const failure of [false, true]) {
  test(failure ? "a failed updater scope launch settles the job instead of leaving it active" : "Linux self-update starts outside the node service cgroup", async (context) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "updater-launch-"));
    const platform = process.platform;
    const previousData = process.env.JOINT_BOB_DATA_DIR;
    const previousRelease = process.env.JOINT_BOB_RELEASE;
    const child = Object.assign(new EventEmitter(), { unref: () => {} });
    const spawn = context.mock.method(childProcess, "spawn", () => child as unknown as childProcess.ChildProcess);
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.JOINT_BOB_DATA_DIR = dataDir;
    process.env.JOINT_BOB_RELEASE = "a".repeat(40);
    try {
      const updater = await import(`../src/updater.ts?launch=${failure}`);
      const job = updater.installLocalRelease(release);
      if (failure) {
        child.emit("exit", 1, null);
        assert.equal(updater.activeUpdateJob(), null, "scope launch failure must immediately unblock retries");
        assert.equal(updater.recentUpdateJobs()[0].state, "failed");
        assert.match(updater.recentUpdateJobs()[0].error!, /helper exited.*1/i);
      } else {
        const [executable, args] = spawn.mock.calls[0].arguments as unknown as [string, string[]];
        assert.equal(executable, "systemd-run", "detached process groups alone remain in joint-bob.service");
        assert.ok(args.includes("--user") && args.includes("--scope"));
        assert.ok(args.includes(`--unit=joint-bob-update-${job.id}`));
        assert.deepEqual(args.slice(-2), [process.execPath, path.resolve("scripts/self-update.mjs")]);
      }
    } finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
      Object.defineProperty(process, "platform", { value: platform });
      if (previousData === undefined) delete process.env.JOINT_BOB_DATA_DIR; else process.env.JOINT_BOB_DATA_DIR = previousData;
      if (previousRelease === undefined) delete process.env.JOINT_BOB_RELEASE; else process.env.JOINT_BOB_RELEASE = previousRelease;
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}
