import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type BrowserContext, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
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
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage();
}, { timeout: 180_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("invitations add membership without selecting projects or replacing clusters", { timeout: 120_000 }, async () => {
  const node = environment.nodes[0];
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-cluster").click();

  await page.getByTestId("cluster-new-button").click();
  await page.getByTestId("cluster-create-name-input").fill("First cluster");
  await page.getByTestId("cluster-create-button").click();
  const selector = page.getByTestId("cluster-selector");
  await page.getByTestId("cluster-details").getByRole("heading", { name: "First cluster", exact: true }).waitFor();
  const clusterId = await selector.inputValue();
  await page.getByTestId("cluster-invite-reveal").click();
  assert.ok(clusterId);

  const posted = page.waitForRequest((request) => request.url().endsWith(`/api/clusters/${clusterId}/invitations`) && request.method() === "POST");
  await page.getByTestId("cluster-invite-generate-button").click();
  const request = await posted;
  assert.deepEqual(JSON.parse(request.postData() ?? "{}"), { expectedEpoch: 1 });
  assert.equal(await page.getByTestId("settingsPanel-cluster").locator('input[type="checkbox"][data-testid="cluster-invite-project-input"]').count(), 0);
  await page.waitForFunction(() => (document.querySelector("#clusterInviteLink") as HTMLInputElement).value !== "");

  await page.getByTestId("cluster-new-button").click();
  await page.getByTestId("cluster-create-name-input").fill("Second cluster");
  await page.getByTestId("cluster-create-button").click();
  await page.getByTestId("cluster-details").getByRole("heading", { name: "Second cluster", exact: true }).waitFor();
  assert.equal(await selector.locator("option").count(), 2);
  const secondClusterId = await selector.inputValue();
  await page.getByTestId("cluster-join-reveal").click();
  await page.getByTestId("cluster-join-link-input").fill("https://example.invalid/manual-membership-link");
  await selector.selectOption(clusterId);
  assert.equal(await page.getByTestId("cluster-join-link-input").inputValue(), "https://example.invalid/manual-membership-link", "cluster switching preserves independent join draft");
  await selector.selectOption(secondClusterId);
  assert.ok(secondClusterId);
  let releaseResponse!: () => void;
  const responseRelease = new Promise<void>((resolve) => { releaseResponse = resolve; });
  let responseFetched!: () => void;
  const fetchedResponse = new Promise<void>((resolve) => { responseFetched = resolve; });
  const invitationUrl = `**/api/clusters/${secondClusterId}/invitations`;
  await page.route(invitationUrl, async (route) => {
    const response = await route.fetch();
    responseFetched();
    await responseRelease;
    await route.fulfill({ response });
  });
  try {
    const delivered = page.waitForResponse((response) => response.url().endsWith(`/api/clusters/${secondClusterId}/invitations`) && response.request().method() === "POST");
    await page.getByTestId("cluster-invite-generate-button").click();
    await fetchedResponse;
    await selector.selectOption(clusterId);
    releaseResponse();
    const response = await delivered;
    await response.finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.getByTestId("cluster-invite-link-input").inputValue(), "");
    assert.equal(await page.getByTestId("cluster-invite-copy-button").isDisabled(), true);
    assert.equal(await selector.inputValue(), clusterId, "late invitation cannot switch selected cluster");
    await page.route("**/api/clusters/join", async route => {
      assert.equal(route.request().method(), "POST");
      const body = route.request().postDataJSON();
      assert.equal(body.link, "https://example.invalid/manual-membership-link");
      assert.equal(typeof body.requestId, "string");
      assert.equal(body.clusterId, undefined, "joining is not scoped to the selected membership");
      await route.fulfill({ status: 400, json: { error: "Fixture invitation expired. Ask for a new link." } });
    });
    await page.getByTestId("cluster-join-button").click();
    await page.getByText("Fixture invitation expired. Ask for a new link.", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("cluster-join-link-input").inputValue(), "https://example.invalid/manual-membership-link");
  } finally {
    releaseResponse();
    await page.unroute(invitationUrl);
  }
});
