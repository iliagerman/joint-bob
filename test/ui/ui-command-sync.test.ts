import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Browser } from "playwright-core";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";
import { launchChrome } from "./launch-chrome.js";

test("a synced command appears in Settings and pastes into chat while its owner is offline", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-command-sync-"));
  const environment = await seedDevEnvironment(root, 2), [owner, receiver] = environment.nodes;
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  let browser: Browser | undefined;
  try {
    for (const node of environment.nodes) children.push(await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") }));
    await pairTwinNodes(environment);
    const session = await signIn(environment, owner);
    assert.equal((await api(owner, session, "POST", "/commands", { name: "Offline review", prompt: "Review without waking the Mac." })).status, 200);
    await stopDevNode(children[0]);
    await stopDevNode(children[1]);
    children[1] = await startDevNode(environment, receiver, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") });
    browser = await launchChrome({ headless: true, env: { ...process.env, HOME: environment.home } });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    context.setDefaultTimeout(20_000);
    const page = await context.newPage();
    await page.goto(receiver.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().waitFor();
    await page.evaluate(async () => (await import("/app/settings.js")).openSettings("commands"));
    const received = page.getByTestId("received-commands-list");
    await received.getByText("Offline review", { exact: true }).waitFor();
    assert.match(await received.innerText(), /Review without waking the Mac\./);
    assert.match(await received.innerText(), /Read only/);
    await page.getByTestId("settings-cancel-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    await page.getByTestId("session-create-button").click();
    await page.getByTestId("new-session-name-input").fill("Local offline command check");
    await page.getByTestId("new-session-name-start-button").click();
    await page.getByText("Ready for your first message", { exact: true }).waitFor();
    await page.getByTestId("chat-message-input").fill("Old draft");
    await page.getByTestId("saved-commands-button").click();
    await page.getByTestId("saved-commands-search").fill("Offline review");
    const used = page.waitForResponse((response) => response.url().includes("/api/commands/") && response.url().endsWith("/use"));
    await page.getByTestId("saved-command-option").getByText("Offline review", { exact: true }).click();
    assert.equal((await used).status(), 200);
    await page.waitForFunction(() => (document.querySelector("#messageInput") as HTMLTextAreaElement).value === "Review without waking the Mac.");
    assert.equal(await page.getByTestId("chat-message-input").inputValue(), "Review without waking the Mac.");
  } finally {
    try { await browser?.close(); }
    finally { await Promise.all(children.map(stopDevNode)); await rm(root, { recursive: true, force: true }); }
  }
});
