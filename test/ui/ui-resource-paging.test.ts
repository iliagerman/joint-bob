import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("Changing a skill's harness keeps the current Resources page", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-activation-paging-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    for (let index = 1; index <= 30; index += 1) {
      const name = `activation-paging-${String(index).padStart(2, "0")}`;
      const folder = path.join(environment.home, "JointBob/.agent-resources/shared/skills", name);
      await mkdir(folder, { recursive: true });
      const description = index > 12 ? "Longer descriptions make later pages scroll. ".repeat(30) : "Short description.";
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
    await page.getByTestId("resources-search-input").fill("activation-paging");
    const rows = page.getByTestId("resources-skill-row");
    await rows.first().getByTestId("resources-activation-toggle").first().waitFor();
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await settle();
    const label = page.getByTestId("resources-page-label");
    // Start on a later page with long rows, after page size was fitted to the short rows.
    while (Number((await rows.first().locator("strong").textContent())!.split("-").at(-1)) < 16) {
      assert.equal(await page.getByTestId("resources-page-next").isEnabled(), true);
      await page.getByTestId("resources-page-next").click();
      await settle();
    }
    const before = await label.textContent();
    assert.ok(Number(before!.split("–")[0]) > 1, `test starts beyond the first page: ${before}`);
    const name = await rows.first().locator("strong").textContent();
    const toggle = page.getByRole("checkbox", { name: `Disable ${name} for Pi`, exact: true });
    await toggle.uncheck();
    await page.getByTestId("resources-status").getByText(`${name} disabled for Pi.`, { exact: false }).waitFor();
    await settle();
    assert.equal(await label.textContent(), before, "disabling a harness must not move to a different page");
    assert.equal(await page.getByRole("checkbox", { name: `Enable ${name} for Pi`, exact: true }).isChecked(), false);
    await page.getByRole("checkbox", { name: `Enable ${name} for Pi`, exact: true }).check();
    await page.getByTestId("resources-status").getByText(`${name} enabled for Pi.`, { exact: false }).waitFor();
    await settle();
    assert.equal(await label.textContent(), before, "enabling a harness must not move to a different page");

    const list = page.getByTestId("resources-list");
    const lastName = await rows.last().locator("strong").textContent();
    const lastToggle = page.getByRole("checkbox", { name: `Disable ${lastName} for Pi`, exact: true });
    await lastToggle.scrollIntoViewIfNeeded();
    const scrollBefore = await list.evaluate((element) => element.scrollTop);
    const layout = await list.evaluate((element) => ({ height: element.clientHeight, scrollHeight: element.scrollHeight, rows: [...element.querySelectorAll(".resources-row")].map((row) => ({ name: row.querySelector("strong")!.textContent, height: row.clientHeight })) }));
    assert.ok(scrollBefore > 0, `precondition: editing a row after scrolling the list: ${before}, ${JSON.stringify(layout)}`);
    await lastToggle.uncheck();
    await page.getByTestId("resources-status").getByText(`${lastName} disabled for Pi.`, { exact: false }).waitFor();
    await settle();
    assert.equal(await label.textContent(), before, "editing a scrolled row keeps its page");
    assert.equal(await list.evaluate((element) => element.scrollTop), scrollBefore, "editing a harness preserves list scroll position");

    const lastRow = rows.filter({ has: page.locator("strong", { hasText: lastName! }) });
    await lastRow.getByTestId("resources-activation-reset").click();
    await page.getByTestId("resources-status").getByText(`${lastName} uses the default for Pi.`, { exact: false }).waitFor();
    await settle();
    assert.equal(await label.textContent(), before, "resetting a harness keeps its page");
    assert.equal(await page.getByRole("checkbox", { name: `Disable ${lastName} for Pi`, exact: true }).isChecked(), true);
    await page.getByTestId("resources-refresh-button").click();
    await page.getByRole("checkbox", { name: `Disable ${lastName} for Pi`, exact: true }).waitFor();
    await settle();
    assert.equal(await label.textContent(), before, "refreshing keeps the current page");
    await page.getByTestId("resources-search-input").fill(lastName!);
    await settle();
    assert.equal(await rows.count(), 1, "changing the search still resets to the first page");
    assert.equal(await rows.locator("strong").textContent(), lastName);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

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
