import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("Settings → Resources shows a conversation's skills and MCP servers, pages without scrolling, and imports skills from a folder", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resources-ui-")); let server: ChildProcess | undefined; let browser;
  try {
    const environment = await seedDevEnvironment(root, 1); const node = environment.nodes[0];
    const source = path.join(environment.home, "my-skills/handy"); await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\nname: handy\ndescription: A handy imported skill\n---\n");
    const mcpConfig = path.join(environment.home, "JointBob/.agent-resources/mcp/config.json");
    await mkdir(path.dirname(mcpConfig), { recursive: true });
    await writeFile(mcpConfig, JSON.stringify({ mcpServers: { "docs-search": { url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer hidden-token" } } } }));
    server = await startDevNode(environment, node); browser = await launchChrome({ headless: process.env.HEADED !== "1" });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(node.url); await page.getByTestId("login-username-input").fill(environment.username); await page.getByTestId("login-password-input").fill(environment.password); await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();

    await page.getByTestId("chat-resources-button").click();
    const dialog = page.getByTestId("resources-panel");
    await dialog.waitFor();
    assert.equal(await page.getByTestId("settings-tab-resources").getAttribute("aria-selected"), "true", "Skills & tools opens the Resources settings page, not its own dialog");
    await page.getByTestId("resources-summary").getByText(/Internal Assistant · .+ conversation/).waitFor();
    assert.equal(await page.getByTestId("resources-scope-select").inputValue(), "conversation");
    assert.equal(await page.getByTestId("resources-harness-select").isDisabled(), true);

    await page.getByTestId("resources-tab-add").click();
    await page.getByTestId("resources-scan-path").fill("~/my-skills");
    await page.getByTestId("resources-scan-button").click();
    const row = page.getByTestId("resources-scan-row").filter({ hasText: "handy" });
    await row.getByText("New", { exact: true }).waitFor();
    await page.getByTestId("resources-select-new-button").click();
    await page.getByTestId("resources-import-button").click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("resources-status").getByText(/Imported 1/).waitFor();
    assert.match(await readFile(path.join(environment.home, "JointBob/.agent-resources/shared/skills/handy/SKILL.md"), "utf8"), /handy imported skill/);
    await row.getByText("Installed", { exact: true }).waitFor();

    await page.getByTestId("resources-tab-skills").click();
    await page.getByTestId("resources-search-input").fill("handy");
    const skill = page.getByTestId("resources-skill-row").filter({ hasText: "handy" });
    await skill.getByText("active", { exact: true }).waitFor();
    await skill.getByText("managed", { exact: true }).waitFor();
    await skill.getByTestId("skill-sharing-summary").getByText("Local only", { exact: true }).waitFor();

    await page.getByTestId("resources-search-input").fill("");
    await page.getByTestId("resources-tab-mcp").click();
    // The seeded conversation runs on Pi, which has no MCP client; the project view shows what others load.
    await page.getByTestId("resources-list").getByText(/Pi does not load MCP servers/).waitFor();
    await page.getByTestId("resources-scope-select").selectOption("project");
    const mcp = page.getByTestId("resources-mcp-row").filter({ hasText: "docs-search" });
    await mcp.getByText("http · https://docs.example.com").waitFor();
    assert.doesNotMatch(await dialog.innerText(), /hidden-token/);

    await page.getByTestId("resources-scope-select").selectOption("cluster");
    await page.getByTestId("resources-summary").getByText(/Every node/).waitFor();
    assert.equal(await page.getByTestId("resources-harness-select").isDisabled(), false);

    await page.getByTestId("resources-tab-skills").click();
    for (const [width, height] of [[1440, 900], [1440, 560], [390, 900]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
      const box = await dialog.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width, `panel fits at ${width}px`);
      const overflow = await dialog.evaluate((panel) => [panel, panel.querySelector("#resourcesList")].map((element) => element!.scrollHeight - element!.clientHeight));
      assert.ok(overflow.every((extra) => extra <= 1), `no vertical scrolling at ${width}×${height}: ${overflow}`);
    }

    await page.getByTestId("resources-tab-paths").click();
    await page.getByTestId("settings-resource-skills-paths").waitFor();
    await page.getByTestId("settings-cancel-button").click();
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); if (server) await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
