import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getOrCreateClusterIdentity } from "../../src/cluster-identity.js";
import { defaultRelayResourceSettings, emptyRelayEnabledResources, publishRelayPolicy, receiveRelayPolicy } from "../../src/relay/resource-policy.js";
import { createMembership, updateMembership } from "../../src/relay/store.js";
import { buildSkillBundle } from "../../src/skill-sharing.js";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

const skillName = "relay-enforced-fixture";

test("a joined relay installs its enforced skill over the local one without an opt-in, marks it in the list, and leaving it restores the local skill", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-enforced-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  // Stands in for the relay's bundle endpoint; its signature checks are covered in test/relay-skill-delivery.test.ts.
  const relaySkill = path.join(root, "relay-source", skillName);
  await mkdir(relaySkill, { recursive: true });
  await writeFile(path.join(relaySkill, "SKILL.md"), `---\nname: ${skillName}\ndescription: Relay version\n---\nRelay\n`);
  const built = await buildSkillBundle(relaySkill, skillName);
  let downloads = 0;
  const bundleServer = http.createServer((_request, response) => {
    downloads += 1;
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ name: skillName, digest: built.digest, bundle: built.bundle }));
  });
  await new Promise<void>((resolve) => bundleServer.listen(0, "127.0.0.1", resolve));
  const relayOrigin = `http://127.0.0.1:${(bundleServer.address() as AddressInfo).port}`;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const managed = path.join(environment.home, "JointBob/.agent-resources/shared/skills", skillName);
    await mkdir(managed, { recursive: true });
    await writeFile(path.join(managed, "SKILL.md"), `---\nname: ${skillName}\ndescription: Local version\n---\nLocal\n`);
    server = await startDevNode(environment, node);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    const inventoryLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/resources/inventory" && response.ok());
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-resources").click();
    await inventoryLoaded;
    await page.getByTestId("resources-search-input").waitFor();

    // Switching between listing tabs keeps the toolbar and tab strip where they are.
    const boxes = async () => Promise.all(["resources-search-input", "resources-tab-skills", "resources-list"].map(async (id) => {
      const box = await page.getByTestId(id).boundingBox();
      return box && { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width) };
    }));
    const skillsLayout = await boxes();
    await page.getByTestId("resources-tab-tools").click();
    assert.deepEqual(await boxes(), skillsLayout, "the Tools tab keeps the Skills tab layout");
    await page.getByTestId("resources-tab-skills").click();

    const receiver = new DatabaseSync(path.join(node.dataDir, "node.db"));
    const relay = new DatabaseSync(":memory:");
    const relayId = randomUUID();
    const identity = getOrCreateClusterIdentity(relay, relayId);
    let membershipId: string;
    try {
      const membership = createMembership(receiver, relayOrigin, identity.fingerprint);
      membershipId = membership.id;
      updateMembership(receiver, membership.id, { status: "admitted", relayNodeId: relayId, fingerprint: identity.fingerprint, environment: "Team relay" });
      const settings = defaultRelayResourceSettings();
      settings.skills.enforce = true;
      const enabled = emptyRelayEnabledResources();
      enabled.skills.pi.push(skillName);
      receiveRelayPolicy(receiver, { ...membership, status: "admitted", relayNodeId: relayId, fingerprint: identity.fingerprint }, identity.publicKey,
        publishRelayPolicy(relay, relayId, [{ action: "enable", name: skillName, harness: "pi" }, { action: "block", name: skillName, harness: "claude" }], { settings, enabled, skillDigests: { [skillName]: built.digest } }));
    } finally { receiver.close(); relay.close(); }

    await page.getByTestId("resources-search-input").fill(skillName);
    await page.getByTestId("resources-refresh-button").click();
    const row = page.getByTestId("resources-skill-row").filter({ hasText: skillName });
    await row.waitFor();
    await page.getByTestId("resources-relay-summary").click();
    await page.getByTestId("resources-relay-status").getByText(/1 relay policy enforced on this node/).waitFor();
    assert.equal(await page.getByTestId("resources-relay-follow").count(), 0, "there is no opt-in to follow a relay");
    await page.getByTestId("resources-relay-select").locator(`option[value="${membershipId}"]`).waitFor({ state: "attached" });
    await page.getByTestId("resources-relay-select").selectOption(membershipId);
    await page.getByTestId("resources-relay-preview").getByText(/Signed version 1 · Enforced on this node/).waitFor();

    await row.getByText("from Team relay").waitFor();
    await row.getByText(/Enforced by Team relay/).waitFor();
    const selectedRelayRule = row.getByText("blocked by selected relay");
    await selectedRelayRule.waitFor();
    assert.match(await selectedRelayRule.getAttribute("title"), /blocks this skill for some agents/);
    assert.equal(await row.getByTestId("skill-remove-button").count(), 0, "a relay-managed skill cannot be removed here");
    await page.getByTestId("resources-relay-sync").getByText(/1 skill delivered here · last synced/).waitFor();
    assert.equal(await page.getByText(/Receiving from \d+ relay/).count(), 0, "relay sync health lives with the relay, not in the node list");
    assert.match(await readFile(path.join(managed, "SKILL.md"), "utf8"), /Relay version/, "the relay's files replace the local skill");
    assert.equal(downloads, 1);

    await page.getByTestId("resources-relay-preview").getByText(/it enforces 1 skill, installed here with their files/).waitFor();
    await page.getByTestId("resources-harness-select").selectOption("pi");
    const toggle = row.getByTestId("resources-activation-toggle");
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await toggle.isDisabled(), true, "the enforced agent is locked on this node");
    assert.match(await page.getByTestId("resources-disable-all").innerText(), /\(0\)/, "bulk actions skip the locked agent");
    await row.getByText(/^Enforced by relay: Team relay/).waitFor();
    await page.getByTestId("resources-state-select").selectOption("relay");
    await row.waitFor();
    await page.getByTestId("resources-state-select").selectOption("");

    // Filter the list to one relay's skills, and group the list by where skills came from.
    await page.getByTestId("resources-harness-select").selectOption("");
    await page.getByTestId("resources-search-input").fill("");
    const relayKey = await page.getByTestId("resources-source-select").locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).find((value) => value.startsWith("relay:")));
    assert.ok(relayKey, "the source filter lists the joined relay");
    await page.getByTestId("resources-source-select").selectOption(relayKey!);
    await row.waitFor();
    assert.equal(await page.getByTestId("resources-skill-row").count(), 1, "only the relay's skill is listed");
    await page.getByTestId("resources-source-select").selectOption("local");
    await row.waitFor({ state: "detached" });
    await page.getByTestId("resources-source-select").selectOption("");
    await page.getByTestId("resources-sort-select").selectOption("source");
    await page.getByTestId("resources-source-heading").first().getByText(/Team relay/).waitFor();
    await page.getByTestId("resources-source-heading").first().getByText("1 skill", { exact: true }).waitFor();
    await page.getByTestId("resources-sort-select").selectOption("");
    await page.getByTestId("resources-search-input").fill(skillName);
    await page.getByTestId("resources-harness-select").selectOption("pi");

    const leaving = new DatabaseSync(path.join(node.dataDir, "node.db"));
    try { updateMembership(leaving, membershipId, { status: "revoked" }); } finally { leaving.close(); }
    await page.getByTestId("resources-refresh-button").click();
    await row.getByText("from Team relay").waitFor({ state: "detached" });
    assert.equal(await page.getByText(/Receiving from 1 relay/).count(), 0, "a relay this node left leaves no sync status");
    assert.match(await readFile(path.join(managed, "SKILL.md"), "utf8"), /Local version/, "leaving the relay restores this node's own skill");
    assert.equal(await toggle.isDisabled(), false, "the node manages the skill again");
  } finally {
    if (browser) await browser.close();
    if (server) await stopDevNode(server);
    await new Promise<void>((resolve) => bundleServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
