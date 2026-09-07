// The cluster invite form shares a project selection: every local project is
// listed, all are checked by default, generating a link posts exactly the
// checked ids, and touching the selection invalidates the generated link.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-invite-"));
  environment = await seedDevEnvironment(root, 1);
  server = await startDevNode(environment, environment.nodes[0]);
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: process.env.HEADED !== "1" });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage();
}, { timeout: 180_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("the invite form shares exactly the selected projects", { timeout: 120_000 }, async () => {
  const node = environment.nodes[0];
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });

  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-cluster").click();
  await page.locator("#clusterNodeUrlInput").fill(node.url);
  await page.getByTestId("cluster-save-button").click();

  const projectInputs = page.locator('[data-testid="cluster-invite-project-input"]');
  await projectInputs.first().waitFor({ timeout: 30_000 });
  const count = await projectInputs.count();
  assert.equal(count, node.projects.length, "every local project is offered for sharing");
  assert.ok(await page.getByTestId("cluster-invite-select-all").isChecked(), "all projects are checked by default");
  assert.ok(await page.getByTestId("cluster-invite-generate-button").isEnabled(), "generate starts enabled");

  // Deselect one project; the request must carry only what stays checked.
  const deselected = projectInputs.nth(1);
  const deselectedId = await deselected.inputValue();
  await deselected.uncheck();
  assert.ok(!(await page.getByTestId("cluster-invite-select-all").isChecked()), "select-all clears when one is off");

  const posted = page.waitForRequest((request) => request.url().endsWith("/api/cluster/invitations") && request.method() === "POST");
  await page.getByTestId("cluster-invite-generate-button").click();
  const request = await posted;
  const payload = JSON.parse(request.postData() ?? "{}") as { projectIds: string[] };
  const expected = node.projects.map((project) => project.id).filter((id) => id !== deselectedId);
  assert.deepEqual([...payload.projectIds].sort(), [...expected].sort());
  await page.waitForFunction(() => (document.querySelector("#clusterInviteLink") as HTMLInputElement).value !== "");
  assert.notEqual(await page.getByTestId("cluster-invite-link-input").inputValue(), "", "a link was generated");

  // Changing the selection invalidates the generated link on screen.
  await deselected.check();
  assert.equal(await page.getByTestId("cluster-invite-link-input").inputValue(), "", "the link clears when the selection changes");
});
