import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

let root: string;
let server: ChildProcess;
let browser: Browser;
let page: Page;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-tool-target-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  server = await startDevNode(environment, node);
  const session = await signIn(environment, node);
  browser = await launchChrome({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const [name, value] = session.cookie.split("=");
  await context.addCookies([{ name, value, url: node.url }]);
  page = await context.newPage();
  await page.goto(node.url);
  await page.getByText("Internal Assistant", { exact: true }).waitFor();
});

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("collapsed tool rows show the file a call read and the skill it loaded", async () => {
  await page.evaluate(`(async () => {
    const transcript = await import("/app/chat-transcript.js");
    transcript.clearChat();
    document.querySelector("#chatPanel").style.display = "flex";
    // Steps start collapsed in the activity panel; open them to see the rows.
    (await import("/app/activity-panel.js")).setActivityStepsOpen(true);
    const skill = transcript.appendToolMessage("read", "target-skill", 0, 1700000000000, { skill: "brainstorming" });
    transcript.updateToolMessage(skill, "# Brainstorming", "Done", false, 100);
    const file = transcript.appendToolMessage("read", "target-file", 0, 1700000000000, { target: "src/pi-service.ts" });
    transcript.updateToolMessage(file, "export {}", "Done", false, 100);
    transcript.appendToolMessage("bash", "target-none", 0, 1700000000000);
  })()`);

  const skill = page.getByTestId("tool-skill");
  assert.equal(await skill.textContent(), "skill · brainstorming");
  assert.equal(await skill.isVisible(), true);
  const file = page.getByTestId("tool-target");
  assert.equal(await file.textContent(), "src/pi-service.ts");
  assert.equal(await file.isVisible(), true);
  // The row stays collapsed: the target is visible on the summary, not in the output.
  assert.equal(await page.locator('[data-testid="tool-output-toggle-target-skill"]').evaluate((element) => element.parentElement.open), false);
  assert.equal(await page.locator('[data-testid="tool-output-toggle-target-none"] .tool-target').count(), 0);
});
