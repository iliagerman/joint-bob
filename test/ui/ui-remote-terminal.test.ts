import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { api, signIn as apiSignIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function signIn(page: Page, url: string, username: string, password: string) {
  await page.goto(url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(username);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await page.locator(".project-card").first().waitFor({ state: "visible" });
}

const PEERS = [
  { id: "00000000-0000-4000-8000-00000000a11c", name: "Locked Mac", local: false, online: true, mapped: true, terminal: false },
  { id: "00000000-0000-4000-8000-00000000b0b0", name: "Open Twin", local: false, online: true, mapped: true, terminal: true },
];

test("the terminal button follows whether the execution node allows terminal access from here", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.route("**/api/projects/*/session-nodes", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.nodes.push(...PEERS);
    await route.fulfill({ response, json: body });
  });
  await signIn(page, node.url, environment.username, environment.password);
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.waitForFunction(async (count) => (await import("/app/state.js")).state.sessionNodes.length === count, PEERS.length + 1);

  const button = page.getByTestId("chat-open-terminal-button");
  const selectNode = (id: string) => page.evaluate(async (nodeId) => {
    const [{ state }, { renderChatSessionControls }] = await Promise.all([import("/app/state.js"), import("/app/chat-controls.js")]);
    state.activeNodeId = nodeId;
    renderChatSessionControls();
  }, id);

  await selectNode(PEERS[0].id);
  assert.equal(await button.isDisabled(), true, "a node that refuses this node's terminal disables the button");
  assert.equal(await button.getAttribute("title"), "Terminal — Locked Mac does not allow terminal access from this node");

  await selectNode(PEERS[1].id);
  assert.equal(await button.isDisabled(), false);
  assert.equal(await button.getAttribute("title"), "Terminal — Open the project folder in Terminal on Open Twin");

  await selectNode(node.nodeId);
  assert.equal(await button.isDisabled(), false, "this node's own terminal stays available");
});

test("the global Settings save persists terminal access settings", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const session = await apiSignIn(environment, node);
  await signIn(page, node.url, environment.username, environment.password);
  const settingsLoaded = page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "GET");
  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();
  await settingsLoaded;
  const terminalPolicyLoaded = page.waitForResponse((response) => response.url().endsWith("/api/terminal-policy") && response.request().method() === "GET");
  await page.getByTestId("settings-tab-node").click();
  await terminalPolicyLoaded;

  const policy = page.getByTestId("settings-terminal-policy");
  const mode = page.getByTestId("terminal-policy-mode");
  const twins = page.getByTestId("settings-remote-terminal-twins");
  const others = page.getByTestId("settings-remote-terminal-other-nodes");
  await policy.waitFor({ state: "visible" });
  assert.equal(await policy.evaluate((element) => Boolean(element.closest("#settingsPanel-node"))), true);
  assert.equal(await twins.evaluate((element) => Boolean(element.closest("#settingsPanel-node"))), true);
  assert.equal(await others.evaluate((element) => Boolean(element.closest("#settingsPanel-node"))), true);
  assert.equal(await mode.inputValue(), "admin", "the fixture starts with terminal access enabled for its admin");
  await mode.selectOption("off");
  const separateSave = page.waitForResponse((response) => response.url().endsWith("/api/terminal-policy") && response.request().method() === "PUT");
  await page.getByTestId("terminal-policy-save").click();
  assert.equal((await separateSave).status(), 200);
  await mode.selectOption("admin");
  await twins.uncheck();
  await others.check();
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "PUT");
  const savedTerminalPolicy = page.waitForResponse((response) => response.url().endsWith("/api/terminal-policy") && response.request().method() === "PUT");
  await page.getByTestId("settings-save-button").click();
  assert.equal((await saved).status(), 200);
  assert.equal((await savedTerminalPolicy).status(), 200, "global Save settings must save changed terminal access");

  const stored = await api<{ remoteTerminal: unknown }>(node, session, "GET", "/settings");
  assert.deepEqual(stored.body.remoteTerminal, { twins: false, otherNodes: true });
  const savedPolicy = await api<{ mode: string }>(node, session, "GET", "/terminal-policy");
  assert.equal(savedPolicy.body.mode, "admin", "the global Settings save must persist Only me terminal access");

  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();
  const reloadedTerminalPolicy = page.waitForResponse((response) => response.url().endsWith("/api/terminal-policy") && response.request().method() === "GET");
  await page.getByTestId("settings-tab-node").click();
  await reloadedTerminalPolicy;
  assert.equal(await mode.inputValue(), "admin", "reopening Settings must show the saved terminal policy");
});
