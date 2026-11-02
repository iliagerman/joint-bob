import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("MCP setup installs multiple servers once and exposes them to Pi, Claude and Kiro without leaking header values", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-ui-")); let server: ChildProcess | undefined, browser;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    server = await startDevNode(environment, node); browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, serviceWorkers: "block" }), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(node.url); await page.getByTestId("login-username-input").fill(environment.username); await page.getByTestId("login-password-input").fill(environment.password); await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
    await page.getByTestId("chat-resources-button").click(); await page.getByTestId("resources-tab-mcp").click();
    await page.getByTestId("managed-mcp-add").click();
    await page.getByTestId("managed-mcp-json").fill(JSON.stringify({ mcpServers: { figma: { url: "https://mcp.figma.com/mcp", headers: { "X-Fixture": "synthetic-private-header" } }, docs: { url: "https://example.invalid/mcp" } } }));
    await page.getByTestId("managed-mcp-install").click(); await page.getByTestId("confirm-accept-button").click();
    const figma = page.getByTestId("resources-mcp-row").filter({ hasText: "figma" });
    await figma.waitFor(); await figma.getByTestId("managed-mcp-sign-in").waitFor();
    await page.getByTestId("resources-mcp-row").filter({ hasText: "docs" }).waitFor();
    assert.doesNotMatch(await page.getByTestId("resources-panel").innerText(), /synthetic-private-header/);
    assert.equal(await page.getByTestId("resources-list").getByText(/Pi does not load MCP servers/).count(), 0);
    await page.getByTestId("resources-scope-select").selectOption("project");
    for (const harness of ["pi", "claude", "kiro"]) {
      await page.getByTestId("resources-harness-select").selectOption(harness);
      await figma.waitFor(); await figma.getByTestId("managed-mcp-sign-in").waitFor();
    }
    await figma.getByTestId("managed-mcp-remove").click(); await page.getByTestId("confirm-accept-button").click();
    await figma.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); if (server) await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
