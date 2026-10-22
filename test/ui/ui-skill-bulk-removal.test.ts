import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { markReceived } from "../../src/skill-sharing-files.js";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("Select all removes every removable skill across pages, preserves relay/native copies and reports partial failures", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-bulk-removal-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    const managed = path.join(environment.home, "JointBob/.agent-resources/shared/skills");
    const names = [...Array.from({ length: 16 }, (_, i) => `bulk-${String(i).padStart(2, "0")}`), "bulk-received"];
    for (const name of [...names, "bulk-relay"]) {
      await mkdir(path.join(managed, name), { recursive: true });
      await writeFile(path.join(managed, name, "SKILL.md"), `---\nname: ${name}\ndescription: Bulk deletion fixture\n---\n`);
    }
    await markReceived(managed, "bulk-received", "00000000-0000-4000-8000-000000000099", node.dataDir);
    await markReceived(managed, "bulk-relay", "relay:fixture", node.dataDir);
    const native = path.join(environment.home, ".pi/skills/bulk-native/SKILL.md");
    await mkdir(path.dirname(native), { recursive: true });
    await writeFile(native, "---\nname: bulk-native\ndescription: Independent native fixture\n---\n");
    server = await startDevNode(environment, node);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const deletes: string[] = [];
    let failOne = true;
    await page.route(`${node.url}/api/resources/skills/*`, async (route) => {
      if (route.request().method() !== "DELETE") { await route.continue(); return; }
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
      deletes.push(name);
      if (name === "bulk-03" && failOne) await route.fulfill({ status: 409, json: { error: "Fixture removal refused" } });
      else await route.continue();
    });
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-resources").click();
    await page.getByTestId("resources-search-input").fill("bulk-");
    await page.getByTestId("resources-list-pager").waitFor();
    await page.getByTestId("resources-select-all").click();
    const remove = page.getByTestId("resources-remove-selected");
    await remove.waitFor();
    assert.match(await remove.innerText(), /\(17\)/, "received copy included, relay and independent native copy excluded");
    assert.ok(await page.getByTestId("resources-skill-row").count() < names.length, "selection spans more than the visible page");
    await remove.click();
    await page.getByTestId("confirm-cancel-button").click();
    assert.deepEqual(deletes, [], "cancel sends no deletion requests");
    await remove.click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("resources-status").getByText(/Removed 16 skills.*1 failed/).waitFor();
    assert.deepEqual([...deletes].sort(), [...names].sort(), "every selected removable skill attempted exactly once, no relay/native delete");
    assert.match(await readFile(path.join(managed, "bulk-relay/SKILL.md"), "utf8"), /bulk-relay/);
    assert.match(await readFile(native, "utf8"), /bulk-native/);
    assert.match(await readFile(path.join(managed, "bulk-03/SKILL.md"), "utf8"), /bulk-03/);
    for (const name of names.filter((name) => name !== "bulk-03")) await assert.rejects(readFile(path.join(managed, name, "SKILL.md")), { code: "ENOENT" });
    assert.match(await remove.innerText(), /\(1\)/, "failed selection retained for explicit retry");
    failOne = false;
    await remove.click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("resources-status").getByText(/Removed 1 skill\./).waitFor();
    await assert.rejects(readFile(path.join(managed, "bulk-03/SKILL.md")), { code: "ENOENT" });
    assert.equal(await remove.isDisabled(), true, "remaining native selection cannot be deleted");
  } finally {
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
