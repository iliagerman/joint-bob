import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("Resources exposes agent switches and enabled filtering for skills, MCP servers and plugins without selecting an agent", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-controls-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    const resources = path.join(environment.home, "JointBob/.agent-resources");
    const files: Record<string, string> = {
      "shared/skills/controls-skill/SKILL.md": "---\nname: controls-skill\ndescription: Visible controls fixture\n---\n",
      "pi/packages.json": '{"packages":["npm:controls-package"]}',
      "mcp/config.json": JSON.stringify({ mcpServers: { "controls-mcp": { command: "fixture-command" } } }),
      "claude/plugins/controls-plugin/.claude-plugin/plugin.json": '{"name":"controls-plugin"}',
    };
    for (let index = 0; index < 12; index++) files[`shared/skills/controls-zbatch-${index}/SKILL.md`] = `---\nname: controls-zbatch-${index}\ndescription: Bulk fixture\n---\n`;
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(resources, file)), { recursive: true });
      await writeFile(path.join(resources, file), content);
    }
    server = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-resources").click();
    await page.getByTestId("resources-search-input").fill("controls-");
    await page.getByTestId("resources-skill-row").filter({ hasText: "controls-skill" }).waitFor();
    assert.equal(await page.getByTestId("resources-harness-select").inputValue(), "");
    for (const [tab, rowKind, name, agents] of [
      ["skills", "skill", "controls-skill", ["Pi", "Claude", "Kiro"]],
      ["mcp", "mcp", "controls-mcp", ["Claude", "Kiro"]],
      ["plugins", "plugin", "controls-plugin", ["Claude"]],
    ] as const) {
      await page.getByTestId(`resources-tab-${tab}`).click();
      const row = page.getByTestId(`resources-${rowKind}-row`).filter({ hasText: name });
      await row.waitFor();
      await page.getByTestId("resources-enable-all").waitFor();
      await page.getByTestId("resources-disable-all").waitFor();
      assert.equal(await row.getByTestId("resources-activation-toggle").count(), agents.length, "all supported agent switches visible by default");
      for (const agent of agents) {
        await row.getByRole("checkbox", { name: `Disable ${name} for ${agent}`, exact: true }).uncheck();
        await page.getByTestId("resources-status").getByText(`${name} disabled for ${agent}.`, { exact: false }).waitFor();
      }
      await page.getByTestId("resources-state-select").selectOption("enabled");
      await row.waitFor({ state: "detached" });
      await page.getByTestId("resources-state-select").selectOption("disabled");
      await row.waitFor();
      await row.getByRole("checkbox", { name: `Enable ${name} for ${agents[0]}`, exact: true }).check();
      await page.getByTestId("resources-status").getByText(`${name} enabled for ${agents[0]}.`, { exact: false }).waitFor();
      await page.getByTestId("resources-state-select").selectOption("enabled");
      await row.waitFor();
      await row.getByRole("button", { name: `Use default for ${name} for ${agents[0]}`, exact: true }).click();
      await page.getByTestId("resources-status").getByText(`${name} uses the default for ${agents[0]}.`, { exact: false }).waitFor();
      await page.getByTestId("resources-state-select").selectOption("");
    }
    const unknown = page.getByTestId("resources-plugin-row").filter({ hasText: "controls-package" });
    await unknown.getByText(/state unknown/).waitFor();
    for (const state of ["enabled", "disabled"]) {
      await page.getByTestId("resources-state-select").selectOption(state);
      await unknown.waitFor({ state: "detached" });
    }
    await page.getByTestId("resources-state-select").selectOption("unknown");
    await unknown.waitFor();
    assert.equal(await unknown.getByTestId("resources-activation-toggle").count(), 0);
    const inventory = await api<{ nodes: Array<{ inventory: { skills: Array<{ name: string; activation: Record<string, { preference: boolean | null }> }> } }> }>(node, session, "GET", "/resources/inventory");
    const skill = inventory.body.nodes[0].inventory.skills.find((item) => item.name === "controls-skill")!;
    assert.equal(skill.activation.pi.preference, null);
    assert.equal(skill.activation.claude.preference, false);
    await page.getByTestId("resources-state-select").selectOption("");
    await page.getByTestId("resources-tab-skills").click();
    await page.getByTestId("resources-search-input").fill("controls-zbatch-");
    await page.getByTestId("resources-harness-select").selectOption("pi");
    await page.getByTestId("resources-disable-all").getByText("Disable all shown (12)").waitFor();
    await page.getByTestId("resources-disable-all").click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("resources-status").getByText("12 agent choices disabled.", { exact: false }).waitFor();
    const bulkInventory = await api<typeof inventory.body>(node, session, "GET", "/resources/inventory");
    assert.equal(bulkInventory.body.nodes[0].inventory.skills.filter((item) => item.name.startsWith("controls-zbatch-") && item.activation.pi.preference === false).length, 12, "bulk action covers hidden pages");
    assert.equal(bulkInventory.body.nodes[0].inventory.skills.find((item) => item.name === "controls-skill")!.activation.pi.preference, null, "search keeps other resources unchanged");
    assert.equal(bulkInventory.body.nodes[0].inventory.skills.find((item) => item.name === "controls-zbatch-0")!.activation.claude.preference, null, "agent filter keeps other agents unchanged");
    await page.getByTestId("resources-state-select").selectOption("disabled");
    await page.getByTestId("resources-enable-all").getByText("Enable all shown (12)").waitFor();
    await page.getByTestId("resources-enable-all").click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("resources-status").getByText("12 agent choices enabled.", { exact: false }).waitFor();
    await page.getByTestId("resources-harness-select").selectOption("");
    await page.getByTestId("resources-tab-plugins").click();
    await page.getByTestId("resources-search-input").fill("controls-package");
    await page.getByTestId("resources-state-select").selectOption("unknown");
    await unknown.waitFor();
    assert.equal(await page.getByTestId("resources-disable-all").isDisabled(), true, "unknown read-only packages excluded");
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(await page.getByTestId("resources-panel").evaluate((element) => element.scrollWidth <= element.clientWidth + 1), "controls fit mobile width");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
