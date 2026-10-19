import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

/** Set JOINT_BOB_UI_SCREENSHOTS to a directory to keep a picture of the tab for review. */
async function keep(page: { screenshot(options: { path: string }): Promise<unknown> }, name: string): Promise<void> {
  const directory = process.env.JOINT_BOB_UI_SCREENSHOTS;
  if (directory) await page.screenshot({ path: path.join(directory, `${name}.png`) });
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

async function write(root: string, relative: string, contents: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), contents);
}

test("Resources → Git repos adds a repository, installs the ticked items, and updates them", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-resources-ui-")); let server: ChildProcess | undefined; let browser;
  try {
    const repository = path.join(root, "repo");
    await mkdir(repository, { recursive: true });
    git(repository, "init", "--quiet", "--initial-branch=main");
    await write(repository, "skills/alpha/SKILL.md", "---\nname: alpha\ndescription: Alpha skill\n---\nv1\n");
    await write(repository, "skills/beta/SKILL.md", "---\nname: beta\ndescription: Beta skill\n---\n");
    await write(repository, "plugins/kit/.claude-plugin/plugin.json", JSON.stringify({ name: "kit", description: "Kit plugin" }));
    await write(repository, ".mcp.json", JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://docs.example.invalid/mcp" } } }));
    git(repository, "add", "-A");
    git(repository, "commit", "--quiet", "-m", "v1");

    const environment = await seedDevEnvironment(root, 1); const node = environment.nodes[0];
    const resources = path.join(environment.home, "JointBob/.agent-resources");
    server = await startDevNode(environment, node); browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(node.url); await page.getByTestId("login-username-input").fill(environment.username); await page.getByTestId("login-password-input").fill(environment.password); await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor(); await page.getByTestId("settings-open-button").click(); await page.getByTestId("settings-tab-resources").click();
    await page.getByTestId("resources-tab-git").click();
    await page.getByTestId("resources-summary").getByText(/not what open conversations have loaded/).waitFor();
    assert.equal(await page.getByTestId("resources-node-select").isVisible(), false, "Git repositories are explicitly scoped to this node");
    await page.getByTestId("resources-git-sources").getByText(/No repositories yet/).waitFor();

    await page.getByTestId("resources-git-url").fill(`file://${repository}`);
    await page.getByTestId("resources-git-ref").fill("main");
    await page.getByTestId("resources-git-add-button").click();
    await page.getByTestId("resources-status").getByText(/2 skills, 1 plugin, 1 MCP server/).waitFor();
    assert.equal(await page.getByTestId("resources-git-source").count(), 1);
    assert.equal(await page.getByTestId("resources-git-item").count(), 4);
    const alpha = page.getByTestId("resources-git-item").filter({ hasText: "alpha" });
    await alpha.getByText("Not installed", { exact: true }).waitFor();
    await alpha.getByText("Not installed on this node", { exact: false }).waitFor();
    assert.equal(await page.getByTestId("resources-git-apply").isDisabled(), true);

    for (const name of ["alpha", "docs", "kit"]) await page.getByTestId("resources-git-item").filter({ hasText: name }).getByTestId("resources-git-item-select").check();
    await alpha.getByText("Selected to install · not installed yet", { exact: false }).waitFor();
    await page.getByTestId("resources-git-apply").getByText("Install 3 selected").waitFor();
    await page.getByTestId("resources-git-apply").click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("resources-status").getByText(/installed .*alpha/).waitFor();
    assert.match(await readFile(path.join(resources, "shared/skills/alpha/SKILL.md"), "utf8"), /v1/);
    assert.ok((await lstat(path.join(resources, "claude/plugins/kit/.claude-plugin/plugin.json"))).isFile());
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(resources, "mcp/config.json"), "utf8")).mcpServers), ["docs"]);
    for (const name of ["alpha", "docs", "kit"]) await page.getByTestId("resources-git-item").filter({ hasText: name }).getByText("Installed", { exact: true }).waitFor();
    const alphaText = await page.getByTestId("resources-git-item").filter({ hasText: "alpha" }).innerText();
    assert.match(alphaText, /Installed here · eligible for new runs: Claude, Kiro, Pi/, alphaText);
    await page.getByTestId("resources-git-item").filter({ hasText: "docs" }).getByText(/Installed here · eligible for new runs: Claude, Kiro/).waitFor();
    await page.getByTestId("resources-git-item").filter({ hasText: "kit" }).getByText(/Installed here · eligible for new runs: Claude/).waitFor();
    await assert.rejects(lstat(path.join(resources, "shared/skills/beta")), { code: "ENOENT" });

    await write(repository, "skills/alpha/SKILL.md", "---\nname: alpha\ndescription: Alpha skill\n---\nv2\n");
    git(repository, "commit", "--quiet", "-am", "v2");
    await page.getByTestId("git-source-check").click();
    await page.getByTestId("git-source-status").getByText(/Update available/).waitFor();
    await page.getByTestId("git-source-update").click();
    await page.getByTestId("resources-status").getByText(/installed alpha/).waitFor();
    assert.match(await readFile(path.join(resources, "shared/skills/alpha/SKILL.md"), "utf8"), /v2/);
    await page.getByTestId("git-source-status").getByText(/Up to date/).waitFor();

    await page.getByTestId("git-source-share").click();
    await page.getByTestId("git-share-dialog").getByText(/No other nodes in your clusters yet/).waitFor();
    await page.getByTestId("git-share-cancel").click();

    await keep(page, "git-resources-desktop");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const auto = page.getByTestId("git-source-auto-update");
      const layout = await auto.evaluate((input) => {
        const label = input.parentElement!;
        const box = label.querySelector("span")!.getBoundingClientRect(), checkbox = input.getBoundingClientRect();
        return { difference: Math.abs(box.y + box.height / 2 - checkbox.y - checkbox.height / 2) };
      });
      assert.ok(layout.difference < 5, `Auto-update text and checkbox share one line at ${width}px: ${layout.difference}px apart`);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      for (const id of ["resources-git-add-button", "resources-git-apply"]) {
        await page.getByTestId(id).scrollIntoViewIfNeeded();
        const box = await page.getByTestId(id).boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 900, `${id} is reachable at ${width}px`);
      }
    }
    await keep(page, "git-resources-mobile");
    await page.setViewportSize({ width: 1440, height: 900 });
    await write(resources, "claude/plugins/kit/commands/custom.md", "Local change\n");
    await page.getByTestId("git-source-remove").click();
    await page.getByTestId("confirm-accept-button").getByText("Remove repository and assets").waitFor();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("resources-git-sources").getByText(/No repositories yet/).waitFor();
    for (const file of ["shared/skills/alpha", "claude/plugins/kit"]) await assert.rejects(lstat(path.join(resources, file)), { code: "ENOENT" });
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(resources, "mcp/config.json"), "utf8")).mcpServers), []);
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); if (server) await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
