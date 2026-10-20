import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SignedIn } from "./dev-nodes.js";
import { waitForAssertion } from "./async-assertion.js";

// Real node processes and WebSocket policy delivery, not a database reopen standing in for a restart.
test("joined relay blocks and per-harness choices survive receiver and publisher restarts and reconnect", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-policy-api-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const [publisher, receiver] = await Promise.all(["publisher", "receiver"].map((name) => seedDevEnvironment(path.join(root, name), 1)));
    const r = publisher.nodes[0], n = receiver.nodes[0];
    const skill = path.join(receiver.home, "JointBob/.agent-resources/shared/skills/policy-restart");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "---\nname: policy-restart\ndescription: restart fixture\n---\n");
    children.push(await startDevNode(publisher, r), await startDevNode(receiver, n));
    let sr = await signIn(publisher, r), sn = await signIn(receiver, n);
    const serving = await fetch(`${r.url}/api/relay/serving`, { method: "PUT", headers: { Cookie: sr.cookie, "x-csrf-token": sr.csrfToken, "content-type": "application/json" }, body: JSON.stringify({ enabled: true, origin: `http://localhost:${r.port}`, environment: "test", requestsEnabled: true, maxMachines: 10, monthlyCapGb: 0, alertTopic: "", ownMachinesOnly: false }) });
    assert.equal(serving.status, 204);
    const rules = [{ action: "block", name: "policy-restart", harness: "pi" }];
    assert.equal((await api(r, sr, "PUT", "/relay/serving/skill-policy", { rules })).status, 200);
    const token = await api<{ link: string }>(r, sr, "POST", "/relay/serving/tokens", { label: "receiver" });
    assert.equal((await api(n, sn, "POST", "/relays", { link: token.body.link })).status, 201);
    const subscription = async (session: SignedIn) => (await api<{ subscriptions: Array<{ id: string; version: number }> }>(n, session, "GET", "/relays/skill-policies")).body.subscriptions[0];
    await waitForAssertion(async () => assert.equal((await subscription(sn))?.version, 1), 15_000);
    const enabled = async (harness: string) => {
      const inventory = await api<{ nodes: Array<{ inventory: { skills: Array<{ name: string; activation: Record<string, { enabled: boolean; preference: boolean | null }> }> } }> }>(n, sn, "GET", "/resources/inventory");
      return inventory.body.nodes[0].inventory.skills.find((item) => item.name === "policy-restart")!.activation[harness];
    };
    assert.equal((await enabled("pi")).enabled, false, "joining a relay enforces its rules without an opt-in");
    assert.equal((await api(n, sn, "PUT", "/resources/activation/item", { kind: "skill", name: "policy-restart", harness: "pi", enabled: true })).status, 200);
    assert.equal((await api(n, sn, "PUT", "/resources/activation/item", { kind: "skill", name: "policy-restart", harness: "claude", enabled: false })).status, 200);
    assert.equal((await enabled("pi")).enabled, false, "the relay block wins over a local enable");
    assert.equal((await api(n, sn, "PUT", `/relays/${(await subscription(sn)).id}/skill-policy-subscription`, { optedIn: false })).status, 404, "there is no way to opt out");
    await stopDevNode(children[1]);
    await stopDevNode(children[0]);
    children[1] = await startDevNode(receiver, n);
    sn = await signIn(receiver, n);
    assert.equal((await enabled("pi")).enabled, false, "cached block remains while publisher is offline");
    assert.equal((await enabled("pi")).preference, true);
    assert.equal((await enabled("claude")).enabled, false);
    children[0] = await startDevNode(publisher, r);
    sr = await signIn(publisher, r);
    const published = await api<{ version: number; rules: unknown[] }>(r, sr, "GET", "/relay/serving/skill-policy");
    assert.equal(published.body.version, 1);
    assert.deepEqual(published.body.rules, rules);
    assert.equal((await api(r, sr, "PUT", "/relay/serving/skill-policy", { rules: [] })).status, 200);
    await waitForAssertion(async () => assert.equal((await subscription(sn)).version, 2), 20_000);
    assert.equal((await enabled("pi")).enabled, true, "reconnect receives new policy without losing explicit enable");
    assert.equal((await enabled("claude")).enabled, false, "other harness keeps explicit disable");
    assert.equal((await api(r, sr, "PUT", "/relay/serving/skill-policy", { rules })).status, 200);
    await waitForAssertion(async () => assert.equal((await enabled("pi")).enabled, false), 10_000);
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
