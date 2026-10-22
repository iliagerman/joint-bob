// Browser suite for Settings → Webhooks' attachments option. It drives a real Chrome against a
// seeded node: a webhook made with "Accept attachments" keeps the option through turning it off
// and on and through editing, and a call to it then hands its files over instead of reading them as text.
//
// Run with `npm run test:file -- test/ui/ui-webhooks.test.ts`. Like the rest of test/ui it needs a
// Chrome binary, and it fails rather than skipping when there is none.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "../dev-nodes.js";

interface Hook { id: string; name: string; model: { provider: string; modelId: string } | null; reasoning: string | null; secretAccountIds: string[]; target: { engine?: string }; enabled: boolean; attachments: boolean; senders: { fields: string[]; allowed: Array<{ value: string; label: string }> } | null }

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let session: SignedIn;
let server: ChildProcess;
let twinServer: ChildProcess;
let browser: Browser;
let page: Page;
let webhookSecretId: string;
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
  environment = await seedDevEnvironment(root, 2);
  node = environment.nodes[0];
  const modelFile = path.join(environment.home, ".pi", "models.json");
  const modelConfig = JSON.parse(await readFile(modelFile, "utf8"));
  modelConfig.providers["dev-environment"].models[0].reasoning = true;
  await writeFile(modelFile, JSON.stringify(modelConfig));
  const extraEnv = { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") };
  server = await startDevNode(environment, node, extraEnv);
  twinServer = await startDevNode(environment, environment.nodes[1], extraEnv);
  await pairTwinNodes(environment);
  session = await signIn(environment, node);
  const savedSecret = await api<{ account: { id: string } }>(node, session, "POST", "/secrets/accounts", {
    label: "Webhook fixture credential", provider: "custom", variables: [{ name: "WEBHOOK_FIXTURE_KEY", kind: "value", value: "synthetic-test-key" }],
  });
  assert.equal(savedSecret.status, 201);
  webhookSecretId = savedSecret.body.account.id;
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage();
  page.setDefaultNavigationTimeout(60_000);
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (twinServer) await stopDevNode(twinServer);
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
  // The initial New button exists before asynchronous owner discovery starts.
  await page.waitForFunction(() =>
    document.querySelector<HTMLSelectElement>("#webhooksOwner")!.options.length > 0
    && document.querySelector<HTMLSelectElement>("#webhooksProject")!.options.length > 0
    && !document.querySelector<HTMLButtonElement>("#webhooksNew")!.disabled,
  );
  await page.getByTestId("webhooks-new-button").click();
  await page.getByTestId("webhooks-form").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("webhooks-attachments-toggle").isChecked(), false, "a new webhook reads calls as text unless asked");
  await page.getByTestId("webhooks-name-input").fill("Deals");
  await page.getByTestId("webhooks-harness-select").selectOption("pi");
  await page.getByTestId("webhooks-model-select").selectOption("dev-environment|dev-model");
  await page.getByTestId("webhooks-effort-select").selectOption("high");
  await page.getByTestId("webhooks-secret-account-checkbox").filter({ visible: true }).first().check();
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

  assert.equal((await hooks())[0].target.engine, "pi");
  assert.deepEqual((await hooks())[0].model, { provider: "dev-environment", modelId: "dev-model" });
  assert.equal((await hooks())[0].reasoning, "high", "toggle keeps execution settings");
  assert.deepEqual((await hooks())[0].secretAccountIds, [webhookSecretId], "toggle keeps attached secret selections");
  await page.getByTestId("webhooks-edit-button").click();
  await page.getByTestId("webhooks-form").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("webhooks-harness-select").inputValue(), "pi");
  assert.equal(await page.getByTestId("webhooks-model-select").inputValue(), "dev-environment|dev-model");
  assert.equal(await page.getByTestId("webhooks-effort-select").inputValue(), "high");
  assert.equal(await page.getByTestId("webhooks-secret-account-checkbox").first().isChecked(), true);
  assert.equal(await page.getByTestId("webhooks-attachments-toggle").isChecked(), true, "the editor shows the stored option");
  await page.getByTestId("webhooks-attachments-toggle").uncheck();
  await page.getByTestId("webhooks-save-button").click();
  await until(async () => (await hooks())[0].attachments === false, "the option is saved off");
  await page.getByTestId("webhooks-edit-button").click();
  await page.getByTestId("webhooks-form").waitFor({ state: "visible" });
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

test("a sender list refuses strangers before the conversation, and Allow lets a refused sender in", async () => {
  const [hook] = await hooks();
  const { secret } = (await api<{ secret: string }>(node, session, "POST", `/webhooks/${hook.id}/regenerate`, {})).body;
  const update = (id: number) => fetch(`${node.url}/hooks/${secret}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ update_id: id, message: { message_id: 1, from: { id }, chat: { id }, text: "hi" } }),
  });

  await page.getByTestId("webhooks-edit-button").click();
  await page.getByTestId("webhooks-form").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("webhooks-senders").isVisible(), false, "the sender list stays folded away until asked for");
  await page.getByTestId("webhooks-senders-toggle").check();
  await page.getByTestId("webhooks-senders").waitFor({ state: "visible" });
  await page.getByTestId("webhooks-sender-telegram-button").click();
  assert.match(await page.getByTestId("webhooks-sender-fields-input").inputValue(), /^message\.from\.id, edited_message\.from\.id, callback_query\.from\.id/);
  await page.getByTestId("webhooks-allowed-senders-input").fill("111 Ilia");
  await page.getByTestId("webhooks-save-button").click();
  await until(async () => Boolean((await hooks())[0].senders), "the sender list is saved");
  assert.deepEqual((await hooks())[0].senders?.allowed, [{ value: "111", label: "Ilia" }]);
  await page.getByTestId("webhooks-list").getByText("1 allowed sender").waitFor();

  assert.deepEqual(await (await update(111)).json(), { accepted: true, attachments: 0 }, "a listed sender gets through");
  const stranger = await update(999);
  assert.equal(stranger.status, 202, "a stranger still gets a 2xx, so Telegram does not keep retrying");
  assert.deepEqual(await stranger.json(), { accepted: false });

  await page.getByTestId("webhooks-calls-button").click();
  const refused = page.getByTestId("webhooks-history").locator(".relay-row").filter({ hasText: "Refused sender 999" });
  await refused.getByText("Refused", { exact: true }).waitFor();
  await refused.getByTestId("webhooks-allow-sender-button").click();
  await page.getByTestId("webhooks-status").filter({ hasText: "Sender 999 is allowed" }).waitFor();
  assert.deepEqual((await hooks())[0].senders?.allowed, [{ value: "111", label: "Ilia" }, { value: "999", label: "" }]);
  assert.deepEqual(await (await update(999)).json(), { accepted: true, attachments: 0 }, "an allowed sender gets through");

  await page.getByTestId("webhooks-edit-button").click();
  await page.getByTestId("webhooks-form").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("webhooks-allowed-senders-input").inputValue(), "111 Ilia\n999");
  await page.getByTestId("webhooks-cancel-button").click();
});

test("creating on a twin uses its targets and address and keeps only one copy", async () => {
  const twin = environment.nodes[1];
  const twinSession = await signIn(environment, twin);
  await page.getByTestId("webhooks-new-button").click();
  await page.getByTestId("webhooks-name-input").fill("Twin only");
  const owner = page.getByTestId("webhooks-owner-select");
  await owner.selectOption(twin.nodeId);
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#webhooksSave")!.disabled);
  assert.equal(await page.getByTestId("webhooks-model-select").inputValue(), "", "changing owner clears previous model choices");
  await page.getByTestId("webhooks-harness-select").selectOption("pi");
  await page.getByTestId("webhooks-model-select").selectOption("dev-environment|dev-model");
  await page.getByTestId("webhooks-effort-select").selectOption("medium");
  await page.getByTestId("webhooks-attachments-toggle").check();
  await page.getByTestId("webhooks-save-button").click();
  await page.getByTestId("webhooks-reveal").waitFor({ state: "visible" });
  const addresses = await page.locator("#webhooksRevealUrls code").allTextContents();
  assert.ok(addresses.some(url => url.startsWith(`${twin.url}/hooks/`)), "only the owner's addresses are revealed");
  assert.ok(addresses.every(url => !url.startsWith(`${node.url}/hooks/`)));
  assert.deepEqual((await hooks()).map(hook => hook.name), ["Deals"], "creating remotely leaves local hooks alone");
  const remoteHooks = () => api<{ webhooks: Hook[] }>(twin, twinSession, "GET", "/webhooks");
  assert.deepEqual((await remoteHooks()).body.webhooks.map(hook => hook.name), ["Twin only"]);
  await page.getByTestId("webhooks-reveal-done-button").click();
  await page.getByTestId("webhooks-list").getByText("Twin only", { exact: true }).waitFor();
  await page.getByTestId("webhooks-edit-button").click();
  await page.getByTestId("webhooks-form").waitFor({ state: "visible" });
  assert.equal(await owner.isDisabled(), true, "editing cannot move or clone a webhook");
  assert.equal(await page.getByTestId("webhooks-attachments-toggle").isChecked(), true);
  await page.getByTestId("webhooks-name-input").fill("Twin renamed");
  await page.getByTestId("webhooks-save-button").click();
  await page.getByTestId("webhooks-list").getByText("Twin renamed", { exact: true }).waitFor();
  const remote = (await remoteHooks()).body.webhooks[0];
  assert.equal(remote.name, "Twin renamed");
  assert.equal(remote.target.engine, "pi");
  assert.deepEqual(remote.model, { provider: "dev-environment", modelId: "dev-model" });
  assert.equal(remote.reasoning, "medium");
  await owner.selectOption(node.nodeId);
  await page.getByTestId("webhooks-list").getByText("Deals", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("webhooks-list").getByText("Twin renamed", { exact: true }).count(), 0);
});

test("an existing conversation fixes the harness while allowing model and effort choices", async () => {
  await page.getByTestId("webhooks-new-button").click();
  await page.getByTestId("webhooks-name-input").fill("Existing conversation");
  await page.getByTestId("webhooks-target-kind-select").selectOption("conversation");
  await page.waitForFunction(() => Boolean(document.querySelector<HTMLSelectElement>("#webhooksConversation")?.selectedOptions[0]?.dataset.engine));
  const engine = await page.locator("#webhooksConversation option:checked").getAttribute("data-engine");
  assert.equal(await page.getByTestId("webhooks-harness-select").isDisabled(), true);
  assert.equal(await page.getByTestId("webhooks-harness-select").inputValue(), engine);
  await page.getByTestId("webhooks-save-button").click();
  await page.getByTestId("webhooks-reveal").waitFor({ state: "visible" });
  const saved = (await hooks()).find(hook => hook.name === "Existing conversation")!;
  assert.equal(saved.target.engine, engine);
  await page.getByTestId("webhooks-reveal-done-button").click();
});

test("the page logged no errors", () => {
  assert.deepEqual(consoleErrors, []);
});
