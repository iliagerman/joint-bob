import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("Resources uses one filter row without relay details and scrolls tall skill content", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-layout-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    const folder = path.join(environment.home, "JointBob/.agent-resources/shared/skills/tall-skill");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "SKILL.md"), `---\nname: tall-skill\ndescription: ${"Detailed instructions for this skill. ".repeat(300)}End of description.\n---\n`);
    server = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    assert.equal((await fetch(`${node.url}/api/relay/serving`, {
      method: "PUT", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, origin: "https://relay.fixture.example", environment: "test", requestsEnabled: false,
        maxMachines: 10, monthlyCapGb: 0, alertTopic: "", ownMachinesOnly: false }),
    })).status, 204);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-resources").click();
    await page.getByTestId("resources-search-input").fill("tall-skill");
    const row = page.getByTestId("resources-skill-row").filter({ hasText: "tall-skill" });
    await row.waitFor();
    const list = page.getByTestId("resources-list"), panel = page.getByTestId("resources-panel");
    const filters = await page.locator(".resources-toolbar > select:visible").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
    assert.ok(filters.length >= 5, "precondition: all resource filters loaded");
    assert.ok(Math.max(...filters) - Math.min(...filters) < 2, `desktop filters share one row: ${filters}`);
    assert.equal(await page.getByTestId("resources-relay-policy").count(), 0, "relay details removed from Resources");
    for (const [width, height] of [[1440, 900], [1440, 560], [390, 620]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await list.evaluate((element) => {
        const description = element.querySelector(".skill-option-description")!;
        return { height: element.clientHeight, overflow: element.scrollHeight - element.clientHeight, scrolling: getComputedStyle(element).overflowY,
          clippedDescription: description.scrollWidth > description.clientWidth + 1 || description.scrollHeight > description.clientHeight + 1 };
      });
      assert.ok(layout.height >= 120, `skill viewport must not collapse at ${width}x${height}: ${JSON.stringify(layout)}`);
      assert.equal(layout.clippedDescription, false, "skill descriptions wrap instead of being cut off");
      assert.ok(layout.overflow > 0, `precondition: real skill content exceeds a page at ${width}x${height}: ${JSON.stringify(layout)}`);
      assert.match(layout.scrolling, /auto|scroll/, "an oversized row must allow user scrolling");
      await list.scrollIntoViewIfNeeded();
      await list.evaluate((element) => { element.scrollTop = 0; });
      await list.hover();
      await page.mouse.wheel(0, 200);
      await page.waitForFunction(() => document.querySelector("#resourcesList")!.scrollTop > 0);
      const lastToggle = row.getByTestId("resources-activation-toggle").last();
      await lastToggle.scrollIntoViewIfNeeded();
      const reachable = await lastToggle.evaluate((element) => {
        const rect = element.getBoundingClientRect(), list = document.querySelector("#resourcesList")!.getBoundingClientRect(), panel = document.querySelector("#settingsPanel-resources")!.getBoundingClientRect();
        return rect.top >= Math.max(list.top, panel.top) && rect.bottom <= Math.min(list.bottom, panel.bottom) + 1;
      });
      assert.ok(reachable, `last agent switch reachable at ${width}x${height}`);
      assert.ok(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), "panel fits horizontally");
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
