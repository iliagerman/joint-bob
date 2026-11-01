import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { runAsAccount } from "../src/account-context.js";
import { createProviderProfile, setProviderProfileSelection } from "../src/provider-profiles/store.js";
import { prepareKiroProfile } from "../src/kiro-profiles/native.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";
import { setResourceOwner } from "../src/ownership.js";
import { listDiscoveredHarnesses } from "../src/harnesses/registry.js";
import type { HarnessSession } from "../src/harnesses/runtime.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("overlapping Kiro preflights keep the account each call selected", async (t) => {
  await getClusterNode();
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-profile-race-"));
  const executable = path.join(root, "kiro-fixture");
  await writeFile(executable, `#!${process.execPath}\nprocess.exit(0);\n`);
  await chmod(executable, 0o700);
  const previous = getSettings().runtimes.kiro;
  updateSettings({ runtimes: { ...getSettings().runtimes, kiro: { ...previous, executable } } });
  const actor = { accountId: "kiro-race-owner", username: "fixture", role: "member" as const, isRemoteLogin: false, homeNodeId: null };
  const entered = [gate(), gate()], proceed = [gate(), gate()];
  const tasks: Promise<void>[] = [];
  let session: HarnessSession | undefined;
  try {
    const project = await addProject("Kiro profile race", root, { writeInstructions: false });
    setResourceOwner("project", project.id, actor.accountId);
    const create = (label: string) => createProviderProfile(actor.accountId, { provider: "kiro", label, kiro: { startUrl: "https://fixture.awsapps.com/start", region: "us-east-1" } });
    const one = create("One"), two = create("Two");
    const homes = await Promise.all([prepareKiroProfile(one), prepareKiroProfile(two)]);
    const choose = (id: string) => setProviderProfileSelection(actor.accountId, { provider: "kiro", scope: "default", scopeId: "", profileId: id });
    const runtime = await listDiscoveredHarnesses().find((item) => item.id === "kiro")!.runtime!();
    session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "race" });
    const native = session as unknown as { checkReady(): Promise<void>; environment(): Promise<NodeJS.ProcessEnv> };
    const seen: string[] = [];
    let calls = 0;
    // Replace only the native version-check I/O. Read production's actual launch environment.
    t.mock.method(native, "checkReady", async () => {
      const index = calls++;
      entered[index].release();
      await proceed[index].promise;
      seen[index] = (await native.environment()).HOME!;
    });
    choose(one.id);
    tasks.push(runAsAccount(actor, () => session!.preflight()));
    await Promise.race([entered[0].promise, tasks[0]]);
    choose(two.id);
    tasks.push(runAsAccount(actor, () => session!.preflight()));
    await Promise.race([entered[1].promise, tasks[1]]);
    proceed[0].release(); await tasks[0];
    proceed[1].release(); await tasks[1];
    assert.deepEqual(seen, homes.map((home) => home.HOME));
  } finally {
    for (const item of proceed) item.release();
    await Promise.allSettled(tasks);
    session?.dispose();
    updateSettings({ runtimes: { ...getSettings().runtimes, kiro: previous } });
    await rm(root, { recursive: true, force: true });
  }
});
