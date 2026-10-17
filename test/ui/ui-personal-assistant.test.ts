import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";
import { launchChrome } from "./launch-chrome.js";

test("personal assistant opens from conversation and saves a link with its screenshot", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-assistant-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    server = await startDevNode(environment, environment.nodes[0]);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    await page.goto(environment.nodes[0].url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
    await page.locator("body.view-chat #chatPanel").waitFor({ state: "visible" });
    await page.waitForFunction(() => !(document.querySelector("#messageInput") as HTMLTextAreaElement).disabled);
    const id = await page.evaluate(async () => {
      const { state } = await import("/app/state.js");
      const { api } = await import("/app/api.js");
      const { assistant } = await api("/api/personal-assistants", { method: "POST", body: JSON.stringify({ projectId: state.activeConversationProjectId, engine: state.engine, sessionId: state.activeSessionId, name: "Phone assistant", instructions: "" }) });
      return assistant.id;
    });
    await page.goto(`${environment.nodes[0].url}/assistant.html?id=${id}`);
    await page.locator("#heading").getByText("Phone assistant").waitFor();
    await page.locator("#instructions").fill("Compare listings by price and warranty");
    await page.locator("#allow-browser").uncheck();
    await page.locator("#allow-terminal").uncheck();
    await page.locator("#settings button").click();
    await page.getByText("Instructions saved").waitFor();
    await page.locator("#title").fill("Phone A");
    await page.locator("#url").fill("https://example.test/phone-a");
    await page.locator("#images").setInputFiles({ name: "listing.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/9ZkAAAAASUVORK5CYII=", "base64") });
    await page.locator("#capture button").click();
    await page.getByText("Item saved").waitFor();
    const card = page.locator("#items article", { hasText: "Phone A" });
    await card.waitFor();
    assert.equal(await card.locator("a").getAttribute("href"), "https://example.test/phone-a");
    await card.locator("img").evaluate(image => (image as HTMLImageElement).decode());
    assert.equal(await card.locator("img").count(), 1);
    assert.ok(new URL(await page.locator("#chat").getAttribute("href") || "", environment.nodes[0].url).searchParams.get("sessionId"));
    await page.reload();
    await page.locator("#heading").getByText("Phone assistant").waitFor();
    assert.equal(await page.locator("#instructions").inputValue(), "Compare listings by price and warranty");
    assert.equal(await page.locator("#allow-browser").isChecked(), false);
    assert.equal(await page.locator("#allow-terminal").isChecked(), false);
    await page.locator("#items article", { hasText: "Phone A" }).waitFor();
  } finally {
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
