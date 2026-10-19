import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

// Wrapped descriptions give rows different heights; Next must still walk every page.
test("Resources Next reaches every skill when rows have different heights", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-paging-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    const names = Array.from({ length: 30 }, (_, index) => `paging-skill-${String(index + 1).padStart(2, "0")}`);
    for (const [index, name] of names.entries()) {
      const folder = path.join(environment.home, "JointBob/.agent-resources/shared/skills", name);
      await mkdir(folder, { recursive: true });
      const description = index % 4 === 0 ? `${"Wraps across several lines of the list. ".repeat(40)}End.` : "Short description.";
      await writeFile(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
    }
    server = await startDevNode(environment, node);
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
    await page.getByTestId("resources-search-input").fill("paging-skill");
    const rows = page.getByTestId("resources-skill-row");
    await rows.filter({ hasText: names[0] }).waitFor();
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await settle();
    const label = page.getByTestId("resources-page-label"), next = page.getByTestId("resources-page-next");
    const seen = new Set<string>();
    const starts: number[] = [];
    for (let clicks = 0; ; clicks += 1) {
      assert.ok(clicks <= names.length, "paging terminates");
      for (const text of await rows.locator("strong").allTextContents()) seen.add(text);
      starts.push(Number((await label.textContent())!.split("–")[0]));
      if (await next.isDisabled()) break;
      await next.click();
      await settle();
    }
    assert.deepEqual([...seen].sort(), names, "every skill is reachable with Next");
    for (let index = 1; index < starts.length; index += 1) assert.ok(starts[index] > starts[index - 1], `Next advances: ${starts.join(", ")}`);
    assert.match((await label.textContent())!, /–30 of 30$/);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
