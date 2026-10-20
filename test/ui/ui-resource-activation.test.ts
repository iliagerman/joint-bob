import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { getOrCreateClusterIdentity } from "../../src/cluster-identity.js";
import { createMembership, updateMembership } from "../../src/relay/store.js";
import { publishRelayPolicy, receiveRelayPolicy } from "../../src/relay/resource-policy.js";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";
import { markReceived } from "../../src/skill-sharing-files.js";

const skillName = "received-activation-fixture";
test("Resources edits per-agent skill activation and node auto-activate default", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-activation-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const shared = path.join(environment.home, "JointBob/.agent-resources/shared/skills");
    const folder = path.join(shared, skillName);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "SKILL.md"), `---\nname: ${skillName}\ndescription: activation test\n---\n`);
    await markReceived(shared, skillName, node.nodeId, node.dataDir);
    server = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-resources").click();
    const auto = page.getByTestId("resources-auto-activate");
    await auto.waitFor();
    assert.equal(await auto.isChecked(), true, "default remains on");
    await page.getByTestId("resources-search-input").fill(skillName);
    await page.getByTestId("resources-harness-select").selectOption("pi");
    const row = page.getByTestId("resources-skill-row").filter({ hasText: skillName });
    const toggle = row.getByTestId("resources-activation-toggle");
    assert.equal(await toggle.isChecked(), true);
    await auto.uncheck();
    await page.getByTestId("resources-status").getByText(/arrive disabled/).waitFor();
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), false);
    await page.getByTestId("resources-harness-select").selectOption("claude");
    assert.equal(await toggle.isChecked(), false);
    await toggle.check();
    await page.getByTestId("resources-status").getByText(/enabled for Claude/).waitFor();
    const inventory = await api<{ nodes: Array<{ node: { local: boolean }; inventory: { skills: Array<{ name: string; activation: Record<string, { enabled: boolean }> }> } }> }>(node, session, "GET", "/resources/inventory");
    assert.equal(inventory.status, 200);
    const skill = inventory.body.nodes[0].inventory.skills.find((item) => item.name === skillName)!;
    assert.deepEqual([skill.activation.pi.enabled, skill.activation.claude.enabled, skill.activation.kiro.enabled], [false, true, false]);
    await auto.check();
    await page.getByTestId("resources-status").getByText(/automatically activate/).waitFor();
    await page.getByTestId("resources-harness-select").selectOption("pi");
    assert.equal(await toggle.isChecked(), true, "the default restored Pi before an explicit disable");
    await toggle.uncheck();
    await page.getByTestId("resources-status").getByText(/disabled for Pi/).waitFor();
    assert.equal(await toggle.isChecked(), false, "explicit disable wins over on-by-default");
    const serving = await fetch(`${node.url}/api/relay/serving`, {
      method: "PUT", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, origin: "https://relay.fixture.example", environment: "test", requestsEnabled: false,
        maxMachines: 10, monthlyCapGb: 0, alertTopic: "", ownMachinesOnly: false }),
    });
    assert.equal(serving.status, 204);
    await page.getByTestId("resources-refresh-button").click();
    const relaySettings = page.getByTestId("resources-relay-policy");
    await relaySettings.waitFor();
    assert.equal(await relaySettings.evaluate((element) => element.tagName), "DETAILS", "relay controls are collapsible instead of crowding the list");
    assert.equal(await relaySettings.evaluate((element: HTMLDetailsElement) => element.open), false, "relay settings start collapsed");
    await page.getByTestId("resources-relay-summary").click();
    await page.getByTestId("resources-relay-help").getByText(/There is no opt-in/).waitFor();
    await page.getByTestId("resources-relay-publisher-summary").click();
    const publisher = page.getByTestId("resources-relay-publish");
    await publisher.waitFor();
    await page.getByTestId("resources-relay-rules").fill(`block ${skillName} pi`);
    await publisher.click();
    const [published] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/relay/serving/skill-policy") && response.request().method() === "PUT"),
      page.getByTestId("confirm-accept-button").click(),
    ]);
    assert.equal(published.status(), 200, await published.text());
    const policy = await api<{ version: number; rules: unknown[] }>(node, session, "GET", "/relay/serving/skill-policy");
    assert.equal(policy.body.version, 1);
    assert.equal(policy.body.rules.length, 1);

    // A signed cached block must not hide the saved local preference or prevent disabling it.
    const receiver = new DatabaseSync(path.join(node.dataDir, "node.db"));
    const relay = new DatabaseSync(":memory:");
    const relayId = randomUUID();
    const identity = getOrCreateClusterIdentity(relay, relayId);
    let membershipId: string;
    try {
      const membership = createMembership(receiver, "https://cached-policy.fixture.example", identity.fingerprint);
      membershipId = membership.id;
      updateMembership(receiver, membership.id, { status: "admitted", relayNodeId: relayId, fingerprint: identity.fingerprint, name: "my-laptop", environment: "Home relay" });
      receiveRelayPolicy(receiver, { ...membership, status: "admitted", relayNodeId: relayId, fingerprint: identity.fingerprint }, identity.publicKey,
        publishRelayPolicy(relay, relayId, [{ action: "block", name: skillName, harness: "claude" }]));
    } finally { receiver.close(); relay.close(); }
    await page.getByTestId("resources-harness-select").selectOption("claude");
    await page.getByTestId("resources-refresh-button").click();
    await page.getByTestId("resources-relay-select").locator(`option[value="${membershipId}"]`).waitFor({ state: "attached" });
    await page.getByTestId("resources-relay-select").selectOption(membershipId);
    assert.equal(await page.getByTestId("resources-relay-follow").count(), 0, "a joined relay's rules apply without an opt-in");
    await row.getByText(/Blocked by relay: Home relay · cached-policy.fixture.example/).waitFor();
    await page.getByTestId("resources-relay-preview").getByText(/Signed version 1 · Enforced on this node/).waitFor();
    const relayOptions = await page.getByTestId("resources-relay-select").locator("option").allTextContents();
    assert.ok(relayOptions.includes("Home relay · cached-policy.fixture.example"));
    assert.equal(relayOptions.some((label) => label.includes("my-laptop")), false, "relay picker names the server, not this machine's membership");
    assert.equal(await toggle.isChecked(), true, "checkbox shows saved enable, not relay's effective block");
    await toggle.uncheck();
    await page.getByTestId("resources-status").getByText(/disabled for Claude/).waitFor();
    const leaving = new DatabaseSync(path.join(node.dataDir, "node.db"));
    try { updateMembership(leaving, membershipId, { status: "revoked" }); } finally { leaving.close(); }
    await page.getByTestId("resources-refresh-button").click();
    await row.getByText("Disabled on this node", { exact: true }).waitFor();
    assert.equal(await toggle.isChecked(), false, "removing relay block preserves the local disable");
  } finally {
    if (browser) await browser.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
