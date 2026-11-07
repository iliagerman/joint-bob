import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSettings, updateSettings } from "../src/settings.js";
import { settingsSchema } from "../src/server/schemas.js";
import { kiroModels } from "../src/harnesses/kiro/models.js";
import runtime from "../src/harnesses/kiro/runtime.js";
import { runHarnessUpdates } from "../src/harness-updater.js";
import kiro from "../src/harnesses/kiro.harness.js";

test("Kiro can be disabled with a missing executable, without discovery, execution or auto-update", async (t) => {
  const previous = getSettings();
  const root = await mkdtemp(path.join(os.tmpdir(), "disabled-kiro-"));
  t.after(async () => { updateSettings(previous); await rm(root, { recursive: true, force: true }); });
  const missing = path.join(root, "missing-kiro");
  const input = settingsSchema.parse({ kiroEnabled: false, runtimes: { kiro: { executable: missing, configPath: root, sessionPath: path.join(root, "sessions") } } });
  updateSettings(input);
  assert.equal(getSettings().kiroEnabled, false);
  updateSettings({ digestAttachments: true });
  assert.equal(getSettings().kiroEnabled, false, "unrelated saves preserve the disable choice");
  assert.deepEqual(await runtime.readiness(root), ["Kiro is disabled on this node"]);
  assert.deepEqual(await runtime.signInProblems(), ["Kiro is disabled on this node"]);
  assert.deepEqual(await kiroModels(), []);
  const native = await import("../src/kiro-profiles/native.js");
  const profile = { id: "disabled-profile", owner: "fixture", label: "Fixture", provider: "kiro" as const, createdAt: new Date().toISOString(), shared: false, kiro: { startUrl: "https://fixture.awsapps.com/start", region: "us-east-1" } };
  await assert.rejects(native.kiroProfileLaunch(profile, {}, ["whoami"]), /Kiro is disabled/);
  assert.deepEqual(await native.kiroProfileLoginState(profile), { signedIn: false, message: "Kiro is disabled on this node" });
  const session = await runtime.open({ projectId: "fixture", cwd: root, sessionId: "disabled-kiro-session" });
  try {
    await assert.rejects(session.preflight(), /Kiro is disabled/);
    await assert.rejects(session.prompt({ text: "must not execute" }), /Kiro is disabled/);
  } finally { session.dispose(); }
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Disabled Kiro must not download"); });
  const [result] = await runHarnessUpdates([kiro]);
  assert.equal(result.state, "disabled");
  assert.equal(network.mock.callCount(), 0);
  network.mock.restore();
  const executable = path.join(root, "kiro");
  await writeFile(executable, '#!/bin/sh\ncase "$1" in --version) echo "kiro-cli 3.1.0";; whoami) echo "fixture";; *) exit 19;; esac\n', { mode: 0o755 });
  updateSettings({ kiroEnabled: true, runtimes: { kiro: { executable, configPath: root, sessionPath: path.join(root, "sessions") } } });
  assert.deepEqual(await runtime.readiness(root), []);
  assert.deepEqual(await runtime.signInProblems(), []);
});
