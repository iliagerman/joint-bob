import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment } from "./dev-nodes.js";

interface HarnessStatus { id: string; ready: boolean; unavailableReason?: string }
interface RuntimeSettings { executable: string; configPath: string; sessionPath: string }

let root: string;
let environment: DevEnvironment;
let server: ChildProcess | undefined;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-harness-readiness-"));
  environment = await seedDevEnvironment(root, 1);
  server = await startDevNode(environment, environment.nodes[0]);
}, { timeout: 120_000 });

after(async () => {
  if (server) await stopDevNode(server);
  await rm(root, { recursive: true, force: true });
});

/** A CLI that is installed but reports no signed-in account, the way `claude auth status` and `kiro-cli whoami` do. */
async function signedOutCli(name: string): Promise<string> {
  const file = path.join(root, `${name}-signed-out`);
  await writeFile(file, `#!/bin/sh
case "$1" in
  --version) echo "1.0.0" ;;
  auth) echo '{"loggedIn": false, "authMethod": "none"}'; exit 1 ;;
  whoami) echo "Not logged in"; exit 1 ;;
  *) exit 1 ;;
esac
`);
  await chmod(file, 0o755);
  return file;
}

async function harnessStatuses(): Promise<HarnessStatus[]> {
  const session = await signIn(environment, environment.nodes[0]);
  const response = await api<{ harnesses: HarnessStatus[] }>(environment.nodes[0], session, "GET", "/harnesses");
  assert.equal(response.status, 200);
  return response.body.harnesses;
}

test("installed and signed-in harnesses are reported ready", { timeout: 60_000 }, async () => {
  const statuses = await harnessStatuses();
  assert.deepEqual(statuses.map(({ id, ready }) => ({ id, ready })), [
    { id: "pi", ready: true }, { id: "claude", ready: true }, { id: "kiro", ready: true },
  ]);
});

test("a signed-out harness is reported unavailable with the reason", { timeout: 60_000 }, async () => {
  const node = environment.nodes[0];
  const session = await signIn(environment, node);
  const current = (await api<{ runtimes: Record<string, RuntimeSettings>; syncthing: { endpoint: string } }>(node, session, "GET", "/settings")).body;
  const put = await api(node, session, "PUT", "/settings", {
    runtimes: {
      ...current.runtimes,
      claude: { ...current.runtimes.claude, executable: await signedOutCli("claude") },
      kiro: { ...current.runtimes.kiro, executable: await signedOutCli("kiro-cli") },
    },
    syncthing: { endpoint: current.syncthing.endpoint },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const statuses = Object.fromEntries((await harnessStatuses()).map((status) => [status.id, status]));
  assert.equal(statuses.pi.ready, true);
  assert.equal(statuses.claude.ready, false);
  assert.match(statuses.claude.unavailableReason ?? "", /Claude is not signed in/);
  assert.equal(statuses.kiro.ready, false);
  assert.match(statuses.kiro.unavailableReason ?? "", /Kiro is not signed in/);
});

test("a harness that cannot load is listed as not ready, and the others still answer", { timeout: 180_000 }, async () => {
  const seeded = await seedDevEnvironment(path.join(root, "broken-package"), 1);
  const node = seeded.nodes[0];
  const resources = path.join(seeded.home, "JointBob/.agent-resources/pi");
  await mkdir(resources, { recursive: true });
  await writeFile(path.join(resources, "packages.json"), '{"packages":["npm:joint-bob-test-no-such-package"]}');
  const broken = await startDevNode(seeded, node);
  try {
    const session = await signIn(seeded, node);
    const response = await api<{ harnesses: HarnessStatus[] }>(node, session, "GET", "/harnesses");
    assert.equal(response.status, 200, "one harness failing to load must not fail the list");
    const pi = response.body.harnesses.find(({ id }) => id === "pi");
    assert.equal(pi?.ready, false);
    assert.match(pi?.unavailableReason ?? "", /joint-bob-test-no-such-package/);
    assert.ok(response.body.harnesses.some(({ id }) => id === "claude"), "the other harnesses are still listed");
  } finally { await stopDevNode(broken); }
});
