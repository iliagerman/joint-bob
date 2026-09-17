import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { browserAgentCredential, browserAgentIdentity } from "../src/browser-agent.js";
import runtime from "../src/harnesses/kiro/runtime.js";
import * as secrets from "../src/secrets.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";

const fixtureSource = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.KIRO_CAPTURE, JSON.stringify({
  browserToken: process.env.JOINT_BOB_BROWSER_TOKEN,
  websiteEnvPresent: process.env.LOGIN_PASSWORD !== undefined,
  args: process.argv.slice(2),
}));
if (process.argv[2] !== "--version" && process.argv[2] !== "whoami") process.exit(2);
`;

test("Kiro preflight refreshes origin-bound website credential snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-website-credentials-"));
  const previousSettings = getSettings();
  const previousCapture = process.env.KIRO_CAPTURE;
  let session: Awaited<ReturnType<typeof runtime.open>> | undefined;
  try {
    const executable = path.join(root, "kiro-fixture.cjs");
    const configPath = path.join(root, "config");
    const sessionPath = path.join(configPath, "sessions");
    const capturePath = path.join(root, "capture.json");
    const cwd = path.join(root, "project");
    await mkdir(sessionPath, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(executable, fixtureSource);
    await chmod(executable, 0o700);
    process.env.KIRO_CAPTURE = capturePath;
    updateSettings({
      runtimes: { ...previousSettings.runtimes, kiro: { executable, configPath, sessionPath } },
      syncthing: { endpoint: "" },
    });

    const project = await addProject("Kiro credentials", cwd, { writeInstructions: false });
    const nativeId = randomUUID();
    const logicalId = randomUUID();
    assert.notEqual(nativeId, logicalId);
    const account = await secrets.saveSecretAccount({
      label: "Kiro Login",
      provider: "custom",
      websiteOrigin: "https://kiro.fixture.test",
      variables: [{ name: "LOGIN_PASSWORD", kind: "value", value: "kiro-website-first" }],
    });
    await secrets.setScopeSecretAccounts("conversation", `kiro:${nativeId}`, [account.id]);
    session = await runtime.open({ projectId: project.id, cwd, sessionId: nativeId, conversationId: logicalId });

    const preflight = async () => {
      await session!.preflight();
      return JSON.parse(await readFile(capturePath, "utf8")) as { browserToken: string; websiteEnvPresent: boolean; args: string[] };
    };
    const first = await preflight();
    assert.equal(first.websiteEnvPresent, false);
    assert.deepEqual(first.args, ["whoami"]);
    assert.deepEqual(browserAgentCredential(first.browserToken, account.id, "LOGIN_PASSWORD"), { origin: "https://kiro.fixture.test", value: "kiro-website-first" });
    assert.deepEqual(browserAgentIdentity(first.browserToken), { projectId: project.id, engine: "kiro", conversationId: logicalId });

    await secrets.saveSecretAccount({ id: account.id, label: "Kiro Login", provider: "custom", websiteOrigin: "https://kiro.fixture.test", variables: [{ name: "LOGIN_PASSWORD", kind: "value", value: "kiro-website-second" }] });
    const rotated = await preflight();
    assert.equal(rotated.websiteEnvPresent, false);
    assert.notEqual(rotated.browserToken, first.browserToken);
    assert.equal(browserAgentCredential(rotated.browserToken, account.id, "LOGIN_PASSWORD").value, "kiro-website-second");
    assert.equal(browserAgentCredential(first.browserToken, account.id, "LOGIN_PASSWORD").value, "kiro-website-first");

    await secrets.deleteSecretAccount(account.id);
    const removed = await preflight();
    assert.equal(removed.websiteEnvPresent, false);
    await assert.rejects(async () => browserAgentCredential(removed.browserToken, account.id, "LOGIN_PASSWORD"), /unavailable/);
  } finally {
    session?.dispose();
    updateSettings({ runtimes: previousSettings.runtimes, syncthing: { endpoint: previousSettings.syncthing.endpoint } });
    if (previousCapture === undefined) delete process.env.KIRO_CAPTURE;
    else process.env.KIRO_CAPTURE = previousCapture;
    await rm(root, { recursive: true, force: true });
  }
});
