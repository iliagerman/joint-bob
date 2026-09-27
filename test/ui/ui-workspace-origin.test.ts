// Two workspaces can share a label: this node's own "Personal" and a "Personal" another node
// shares through a cluster. The project picker and the Workspaces settings must say which
// is which, and a node without workspaces must say how to get one.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("shared workspaces name their node in the project picker and settings", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-workspace-origin-ui-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    server = await startDevNode(environment, node);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    let workspaces: object[] = [
      { id: "personal", label: "Personal" },
      { id: "shared-abc", label: "Personal", source: { nodeId: "homeserver", name: "Homeserver" } },
    ];
    await page.route("**/api/workspaces", async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      await route.fulfill({ json: { workspaces } });
    });
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();

    await page.getByTestId("project-create-button").click();
    const options = () => page.getByTestId("project-form-workspace-select").locator("option").allTextContents();
    assert.deepEqual(await options(), ["Personal", "Personal · Homeserver"], "the picker tells the two Personal workspaces apart");
    await page.getByTestId("project-form-cancel-button").click();

    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-workspaces").click();
    const listed = await page.getByTestId("workspace-list").innerText();
    assert.match(listed, /Personal · Homeserver/, "settings names the node sharing the workspace");
    await page.getByTestId("settings-cancel-button").click();

    workspaces = [];
    await page.reload();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("project-create-button").click();
    assert.deepEqual(await options(), ["Create a workspace in Settings > Workspaces first"], "a node without workspaces says how to get one");
  } finally {
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
