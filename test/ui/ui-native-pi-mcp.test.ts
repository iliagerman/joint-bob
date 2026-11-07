import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";
import { nativeCallback, nativeMcpFixture } from "../native-mcp-fixture.js";
import { piSdkEntry } from "../../src/pi-sdk.js";
const sdk = await import(piSdkEntry ?? import.meta.resolve("@earendil-works/pi-coding-agent"));
test("Resources supports native Pi OAuth or reports that the selected SDK needs an update", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-pi-mcp-ui-")), fixture = await nativeMcpFixture();
  let server: ChildProcess | undefined, browser;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    server = await startDevNode(environment, node); browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, serviceWorkers: "block" });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username); await page.getByTestId("login-password-input").fill(environment.password); await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
    await page.getByTestId("chat-resources-button").click(); await page.getByTestId("resources-tab-mcp").click();
    await page.getByTestId("managed-mcp-add").click();
    await page.getByTestId("managed-mcp-name").fill("native_fixture"); await page.getByTestId("managed-mcp-url").fill(`${fixture.origin}/mcp`);
    await page.getByTestId("managed-mcp-auth-mode").selectOption("native");
    await page.getByTestId("managed-mcp-install").click(); await page.getByTestId("confirm-accept-button").click();
    const row = page.getByTestId("resources-mcp-row").filter({ hasText: "native_fixture" }); await row.waitFor();
    assert.match(await row.innerText(), /Pi/);
    if (typeof sdk.createMcpExtension !== "function") {
      await row.getByTestId("managed-mcp-sign-in").click();
      await row.getByTestId("managed-mcp-error").filter({ hasText: /Update the Pi harness/ }).waitFor();
      assert.equal(fixture.registrations(), 0, "unsupported Pi must not silently start shared OAuth");
      assert.deepEqual(errors, []);
      return;
    }
    const popupPromise = page.waitForEvent("popup"); await row.getByTestId("managed-mcp-sign-in").click(); const popup = await popupPromise;
    await popup.waitForURL(url => url.searchParams.has("state"));
    const callback = nativeCallback(popup.url());
    await page.getByTestId("managed-mcp-callback").fill(callback.href);
    await page.getByTestId("managed-mcp-done").click();
    await row.getByTestId("managed-mcp-status").filter({ hasText: /^connected$/ }).waitFor().catch(async error => {
      throw new Error(`${error.message}\nNative row: ${await row.innerText()}`);
    });
    await row.getByTestId("managed-mcp-sign-out").click();
    await page.getByTestId("managed-mcp-check").click();
    await row.getByTestId("managed-mcp-status").filter({ hasText: "Sign in required" }).waitFor();
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); if (server) await stopDevNode(server); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
