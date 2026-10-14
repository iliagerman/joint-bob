// Browser suite for Settings → Webhooks' attachments option. It drives a real Chrome against a
// seeded node: a webhook made with "Accept attachments" keeps the option through turning it off
// and on and through editing, and a call to it then hands its files over instead of reading them as text.
//
// Run with `npm run test:file -- test/ui/ui-webhooks.test.ts`. Like the rest of test/ui it needs a
// Chrome binary, and it fails rather than skipping when there is none.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "../dev-nodes.js";

interface Hook { id: string; name: string; target: unknown; enabled: boolean; attachments: boolean }

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let session: SignedIn;
let server: ChildProcess;
let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];

async function hooks(): Promise<Hook[]> {
  return (await api<{ webhooks: Hook[] }>(node, session, "GET", "/webhooks")).body.webhooks;
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-webhooks-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  session = await signIn(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage();
  page.setDefaultNavigationTimeout(60_000);
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("signing in reaches the app", async () => {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("settings-open-button").waitFor({ timeout: 20_000 });
});

test("a webhook made with Accept attachments keeps the option through turning off and editing", async () => {
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-webhooks").click();
  await page.getByTestId("webhooks-new-button").click();
  assert.equal(await page.getByTestId("webhooks-attachments-toggle").isChecked(), false, "a new webhook reads calls as text unless asked");
  await page.getByTestId("webhooks-name-input").fill("Deals");
  await page.getByTestId("webhooks-attachments-toggle").check();
  await page.getByTestId("webhooks-save-button").click();
  await page.getByTestId("webhooks-reveal").waitFor({ state: "visible" });
  await page.getByTestId("webhooks-reveal-done-button").click();
  await page.getByTestId("webhooks-list").getByText("accepts attachments").waitFor();
  assert.deepEqual((await hooks()).map(({ name, enabled, attachments }) => [name, enabled, attachments]), [["Deals", true, true]]);

  await page.getByTestId("webhooks-toggle-button").click();
  await until(async () => (await hooks())[0].enabled === false, "the webhook is off");
  assert.equal((await hooks())[0].attachments, true, "turning a webhook off leaves its attachments option alone");
  await page.getByTestId("webhooks-toggle-button").filter({ hasText: "Turn on" }).click();
  await until(async () => (await hooks())[0].enabled, "the webhook is on again");

  await page.getByTestId("webhooks-edit-button").click();
  assert.equal(await page.getByTestId("webhooks-attachments-toggle").isChecked(), true, "the editor shows the stored option");
  await page.getByTestId("webhooks-attachments-toggle").uncheck();
  await page.getByTestId("webhooks-save-button").click();
  await until(async () => (await hooks())[0].attachments === false, "the option is saved off");
  await page.getByTestId("webhooks-edit-button").click();
  await page.getByTestId("webhooks-attachments-toggle").check();
  await page.getByTestId("webhooks-save-button").click();
  await until(async () => (await hooks())[0].attachments, "the option is saved on");
});

test("a call to the webhook hands over its files instead of reading them as text", async () => {
  const [hook] = await hooks();
  const { secret } = (await api<{ secret: string }>(node, session, "POST", `/webhooks/${hook.id}/regenerate`, {})).body;
  const form = new FormData();
  form.append("url", "https://example.com/ad/1");
  form.append("shot", new Blob([Buffer.from("png")], { type: "image/png" }), "screen.png");
  const multipart = await fetch(`${node.url}/hooks/${secret}`, { method: "POST", body: form });
  assert.equal(multipart.status, 202);
  assert.deepEqual(await multipart.json(), { accepted: true, attachments: 1 });

  const json = await fetch(`${node.url}/hooks/${secret}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/ad/2", attachments: [{ name: "a.png", data: "cG5n" }, { name: "b.pdf", data: "cGRm" }] }),
  });
  assert.deepEqual(await json.json(), { accepted: true, attachments: 2 });

  const broken = await fetch(`${node.url}/hooks/${secret}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attachments: [{ name: "bad.png", data: "not base64!" }] }),
  });
  assert.equal(broken.status, 400);
  assert.match(await broken.text(), /"bad\.png" is not valid base64/);

  assert.equal((await api(node, session, "PUT", `/webhooks/${hook.id}`, { name: hook.name, target: hook.target, attachments: false })).status, 200);
  const plain = await fetch(`${node.url}/hooks/${secret}`, { method: "POST", body: form });
  assert.deepEqual(await plain.json(), { accepted: true, attachments: 0 }, "with the option off the same call is all text");
});

test("the page logged no errors", () => {
  assert.deepEqual(consoleErrors, []);
});
