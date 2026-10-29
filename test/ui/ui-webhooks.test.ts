// Browser suite for Settings → Webhooks' attachments option. It drives a real Chrome against a
// seeded node: a webhook made with "Accept attachments" keeps the option through turning it off
// and on and through editing, and a call to it then hands its files over instead of reading them as text.
//
// Run with `npm run test:file -- test/ui/ui-webhooks.test.ts`. Like the rest of test/ui it needs a
// Chrome binary, and it fails rather than skipping when there is none.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "../dev-nodes.js";

interface Hook { id: string; name: string; titleTemplate: string; model: { provider: string; modelId: string } | null; reasoning: string | null; secretAccountIds: string[]; tags: { managedTagIds: string[]; manualTags: string[] }; target: { engine?: string }; enabled: boolean; attachments: boolean; senders: { fields: string[]; allowed: Array<{ value: string; label: string }> } | null }

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
const expectedConsoleErrors: string[] = [];
let expectingMemoryConflict = false;

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
  for (const project of node.projects) {
    const existingSkill = path.join(project.path, ".agents", "skills", "project-review");
    await mkdir(existingSkill, { recursive: true });
    await writeFile(path.join(existingSkill, "SKILL.md"), "---\nname: project-review\ndescription: Review project notes.\n---\nRead the linked reference files.\n");
  }
  const uploadSkill = path.join(root, "uploaded-review");
  await mkdir(path.join(uploadSkill, "references"), { recursive: true });
  const uploadedSkillText = "---\nname: uploaded-review\ndescription: Review uploaded fixtures.\n---\nKeep the references nearby.\n";
  await writeFile(path.join(uploadSkill, "SKILL.md"), uploadedSkillText);
  await writeFile(path.join(uploadSkill, "references", "notes.md"), "Private reference.\n");
  const gitRepo = path.join(root, "git-skill-repo");
  const gitSkill = path.join(gitRepo, "skills", "repo-review");
  await mkdir(gitSkill, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main", gitRepo]);
  execFileSync("git", ["-C", gitRepo, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", gitRepo, "config", "user.name", "Webhook Test"]);
  await writeFile(path.join(gitSkill, "SKILL.md"), "---\nname: repo-review\ndescription: Review repository changes.\n---\n");
  execFileSync("git", ["-C", gitRepo, "add", "."]);
  execFileSync("git", ["-C", gitRepo, "commit", "-m", "add review skill"]);
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
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (expectingMemoryConflict && /status of 409 \(Conflict\)/.test(message.text())) expectedConsoleErrors.push(message.text());
    else consoleErrors.push(message.text());
  });
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
  const projects = await api<{ projects: Array<{ id: string; name: string; type: string }> }>(node, session, "GET", "/projects");
  const project = projects.body.projects.find(item => item.name === "Internal Assistant")!;
  const managedTag = await api<{ tag: { id: string } }>(node, session, "POST", `/workspaces/${project.type}/automation-tags`, { name: "Webhook managed" });
  assert.equal(managedTag.status, 201, JSON.stringify(managedTag.body));
  await page.getByTestId("webhooks-new-button").click();
  await page.getByTestId("webhooks-form").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("webhooks-attachments-toggle").isChecked(), false, "a new webhook reads calls as text unless asked");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="webhooks-tags-managed"] option').length > 0);
  await page.getByTestId("webhooks-tags-managed").selectOption(managedTag.body.tag.id);
  await page.getByTestId("webhooks-tags-manual").fill("Manual webhook label");
  await page.getByTestId("webhooks-tags-add-manual").click();
  await page.getByTestId("webhooks-name-input").fill("Deals");
  for (const viewport of [{ width: 1440, height: 700 }, { width: 390, height: 700 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.locator("#webhooksSetupPanel").evaluate(element => {
      const tags = element.querySelector('[data-testid="webhooks-automation-tags"]')!;
      return { overflow: getComputedStyle(element).overflowY, tagsHeight: tags.getBoundingClientRect().height, width: element.clientWidth, contentWidth: element.scrollWidth };
    });
    assert.equal(layout.overflow, "auto");
    assert.ok(layout.tagsHeight < (viewport.width < 500 ? 400 : 240), `tag controls stay compact and wrap on mobile: ${JSON.stringify({ viewport, layout })}`);
    assert.ok(layout.contentWidth <= layout.width + 1, "setup fits without horizontal clipping");
    const bounds = await page.getByTestId("webhooks-save-button").boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, "webhook actions remain reachable");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("webhooks-title-template-input").fill("pr-[PR_REVIEW]");
  await page.getByTestId("webhooks-harness-select").selectOption("pi");
  await page.getByTestId("webhooks-model-select").selectOption("dev-environment|dev-model");
  await page.getByTestId("webhooks-effort-select").selectOption("high");
  await page.getByTestId("webhooks-tab-access").click();
  await page.getByTestId("webhooks-secret-account-checkbox").filter({ visible: true }).first().check();
  await page.getByTestId("webhooks-attachments-toggle").check();
  await page.getByTestId("webhooks-save-button").click();
  await page.getByTestId("webhooks-reveal").waitFor({ state: "visible" });
  await page.getByTestId("webhooks-reveal-done-button").click();
  await page.getByTestId("webhooks-back-button").click();
  await page.getByTestId("webhooks-list").getByText("accepts attachments").waitFor();
  assert.deepEqual((await hooks()).map(({ name, enabled, attachments, tags }) => [name, enabled, attachments, tags]), [["Deals", true, true, { managedTagIds: [managedTag.body.tag.id], manualTags: ["Manual webhook label"] }]]);

  await page.getByTestId("webhooks-toggle-button").click();
  await until(async () => (await hooks())[0].enabled === false, "the webhook is off");
  assert.equal((await hooks())[0].attachments, true, "turning a webhook off leaves its attachments option alone");
  await page.getByTestId("webhooks-toggle-button").filter({ hasText: "Turn on" }).click();
  await until(async () => (await hooks())[0].enabled, "the webhook is on again");

  assert.equal((await hooks())[0].target.engine, "pi");
  assert.equal((await hooks())[0].titleTemplate, "pr-[PR_REVIEW]", "turning off and on preserves the template");
  assert.deepEqual((await hooks())[0].model, { provider: "dev-environment", modelId: "dev-model" });
  assert.equal((await hooks())[0].reasoning, "high", "toggle keeps execution settings");
  assert.deepEqual((await hooks())[0].secretAccountIds, [webhookSecretId], "toggle keeps attached secret selections");
  await page.getByTestId("webhooks-open-button").click();
  await page.getByTestId("webhooks-form").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("webhooks-harness-select").inputValue(), "pi");
  assert.equal(await page.getByTestId("webhooks-title-template-input").inputValue(), "pr-[PR_REVIEW]");
  assert.equal(await page.getByTestId("webhooks-model-select").inputValue(), "dev-environment|dev-model");
  assert.equal(await page.getByTestId("webhooks-effort-select").inputValue(), "high");
  await page.getByTestId("webhooks-tab-access").click();
  assert.equal(await page.getByTestId("webhooks-secret-account-checkbox").first().isChecked(), true);
  assert.equal(await page.getByTestId("webhooks-attachments-toggle").isChecked(), true, "the editor shows the stored option");
  assert.equal(await page.getByTestId("webhooks-savebar").isVisible(), false, "nothing to save until something changes");
  await page.getByTestId("webhooks-attachments-toggle").uncheck();
  await page.getByTestId("webhooks-save-button").click();
  await until(async () => (await hooks())[0].attachments === false, "the option is saved off");
  await page.getByTestId("webhooks-attachments-toggle").check();
  await page.getByTestId("webhooks-save-button").click();
  await until(async () => (await hooks())[0].attachments, "the option is saved on");

  const hook = (await hooks())[0];
  const statusLine = page.getByTestId("webhooks-status");
  await page.getByTestId("webhooks-tab-memory").click();
  await page.getByTestId("webhook-memory-enabled-toggle").check();
  await until(async () => (await api<{ enabled: boolean }>(node, session, "GET", `/webhooks/${hook.id}/memory`)).body.enabled, "webhook memory is enabled");
  await page.getByTestId("webhook-memory-content-input").fill("# Durable note\\nKeep this private to the webhook.\\n");
  await page.getByTestId("webhook-memory-save-button").click();
  await until(async () => { const r = await api<{ content: string }>(node, session, "GET", `/webhooks/${hook.id}/memory`); return (r.body.content ?? "").includes("Keep this private"); }, "memory is saved");
  const savedMemory = await api<{ content: string; revision: string }>(node, session, "GET", `/webhooks/${hook.id}/memory`);
  const memoryDraft = "# User draft\\nKeep this edit until the conflict is resolved.\\n";
  await page.getByTestId("webhook-memory-content-input").fill(memoryDraft);
  const agentEdit = await api(node, session, "PUT", `/webhooks/${hook.id}/memory`, { content: "# Agent update\\n", expectedRevision: savedMemory.body.revision });
  assert.equal(agentEdit.status, 200);
  expectingMemoryConflict = true;
  await page.getByTestId("webhook-memory-save-button").click();
  await statusLine.getByText(/changed since you read/i).waitFor();
  expectingMemoryConflict = false;
  assert.equal(await page.getByTestId("webhook-memory-content-input").inputValue(), memoryDraft, "a 409 preserves the user's unsaved draft");
  await page.getByTestId("webhook-memory-discard-button").click();
  await until(async () => (await page.getByTestId("webhook-memory-content-input").inputValue()) === "# Agent update\\n", "the newer memory is reloaded");
  await page.getByTestId("webhook-memory-upload-input").setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Uploaded note\\n") });
  await until(async () => (await api<{ content: string }>(node, session, "GET", `/webhooks/${hook.id}/memory`)).body.content === "# Uploaded note\\n", "the Markdown upload is saved");
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("webhook-memory-download-button").click();
  assert.equal((await downloadPromise).suggestedFilename(), "MEMORY.md");
  const resetButton = page.getByTestId("webhook-memory-reset-button");
  await resetButton.click();
  assert.equal(await resetButton.getAttribute("data-armed"), "true", "reset asks for confirmation first");
  await resetButton.click();
  await statusLine.getByText("Memory reset.").waitFor();
  await until(async () => (await api<{ content: string }>(node, session, "GET", `/webhooks/${hook.id}/memory`)).body.content === "", "explicit reset clears the memory");

  await page.getByTestId("webhooks-tab-files").click();
  await page.getByTestId("webhook-resource-files-input").setInputFiles({ name: "rates.csv", mimeType: "text/csv", buffer: Buffer.from("day,rate\\n1,2\\n") });
  await page.getByTestId("webhook-resource-description-input").fill("Rates used by the agent");
  await page.getByTestId("webhook-resource-add-button").click();
  await page.getByTestId("webhook-resource-list").getByText("rates.csv", { exact: true }).waitFor();
  const resources = await api<{ resources: Array<{ name: string; description: string; path?: string }> }>(node, session, "GET", `/webhooks/${hook.id}/resources`);
  assert.deepEqual(resources.body.resources.map(({ name, description, path: filePath }) => [name, description, filePath]), [["rates.csv", "Rates used by the agent", undefined]]);

  await page.getByTestId("webhooks-tab-skills").click();
  const inventoryApi = await api<{ skills: Array<{ name: string }> }>(node, session, "GET", `/webhooks/${hook.id}/skills?inventory=1`);
  assert.equal(inventoryApi.status, 200, JSON.stringify(inventoryApi.body));
  await page.getByTestId("webhook-skill-add-button").click();
  await page.getByTestId("webhook-skill-search-input").fill("project-review");
  await page.getByTestId("webhook-skill-inventory").locator(".relay-row").filter({ hasText: "project-review" }).first().getByTestId("webhook-skill-import-existing-button").click();
  await page.getByTestId("webhook-skill-list").getByText(/project-review/).waitFor();
  await page.getByTestId("webhook-skill-method-git").click();
  await page.getByTestId("webhook-skill-git-url-input").fill(pathToFileURL(path.join(root, "git-skill-repo")).href);
  await page.getByTestId("webhook-skill-git-discover-button").click();
  await page.getByText(/repo-review · Review repository changes/).waitFor();
  await page.getByTestId("webhook-git-skill-import-button").click();
  await page.getByTestId("webhook-skill-list").getByText(/repo-review/).waitFor();
  await writeFile(path.join(root, "git-skill-repo", "skills", "repo-review", "SKILL.md"), "---\nname: repo-review\ndescription: Review updated repository changes.\n---\n");
  execFileSync("git", ["-C", path.join(root, "git-skill-repo"), "add", "."]);
  execFileSync("git", ["-C", path.join(root, "git-skill-repo"), "commit", "-m", "update review skill"]);
  const updateButton = page.getByTestId("webhook-git-skill-update-button");
  await updateButton.click();
  await updateButton.click();
  await statusLine.getByText("Git skill updated.").waitFor();
  const uploadSkill = path.join(root, "uploaded-review");
  const uploadedSkillText = await readFile(path.join(uploadSkill, "SKILL.md"), "utf8");
  await page.getByTestId("webhook-skill-folder-input").setInputFiles(uploadSkill);
  await page.getByTestId("webhook-skill-list").getByText(/uploaded-review/).waitFor();
  assert.equal(await readFile(path.join(uploadSkill, "SKILL.md"), "utf8"), uploadedSkillText, "upload copies the folder without changing its source");
  await page.getByTestId("webhooks-back-button").click();
  await page.getByTestId("webhooks-list").waitFor({ state: "visible" });
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

  await page.getByTestId("webhooks-open-button").click();
  await page.getByTestId("webhooks-form").waitFor({ state: "visible" });
  await page.getByTestId("webhooks-tab-access").click();
  assert.equal(await page.getByTestId("webhooks-senders").isVisible(), false, "the sender list stays folded away until asked for");
  await page.getByTestId("webhooks-senders-toggle").check();
  await page.getByTestId("webhooks-senders").waitFor({ state: "visible" });
  await page.getByTestId("webhooks-sender-telegram-button").click();
  assert.match(await page.getByTestId("webhooks-sender-fields-input").inputValue(), /^message\.from\.id, edited_message\.from\.id, callback_query\.from\.id/);
  await page.getByTestId("webhooks-allowed-senders-input").fill("111 Ilia");
  await page.getByTestId("webhooks-save-button").click();
  await until(async () => Boolean((await hooks())[0].senders), "the sender list is saved");
  assert.deepEqual((await hooks())[0].senders?.allowed, [{ value: "111", label: "Ilia" }]);
  await page.getByTestId("webhooks-back-button").click();
  await page.getByTestId("webhooks-list").getByText("1 allowed sender").waitFor();

  assert.deepEqual(await (await update(111)).json(), { accepted: true, attachments: 0 }, "a listed sender gets through");
  const stranger = await update(999);
  assert.equal(stranger.status, 202, "a stranger still gets a 2xx, so Telegram does not keep retrying");
  assert.deepEqual(await stranger.json(), { accepted: false });

  await page.getByTestId("webhooks-calls-button").click();
  await page.getByTestId("webhooks-form").waitFor({ state: "visible" });
  const refused = page.getByTestId("webhooks-history").locator(".relay-row").filter({ hasText: "Refused sender 999" });
  await refused.getByText("Refused", { exact: true }).waitFor();
  await refused.getByTestId("webhooks-allow-sender-button").click();
  await page.getByTestId("webhooks-status").filter({ hasText: "Sender 999 is allowed" }).waitFor();
  assert.deepEqual((await hooks())[0].senders?.allowed, [{ value: "111", label: "Ilia" }, { value: "999", label: "" }]);
  assert.deepEqual(await (await update(999)).json(), { accepted: true, attachments: 0 }, "an allowed sender gets through");

  await page.getByTestId("webhooks-tab-access").click();
  assert.equal(await page.getByTestId("webhooks-allowed-senders-input").inputValue(), "111 Ilia\n999");
  await page.getByTestId("webhooks-back-button").click();
});

test("creating on a twin uses its targets and address and keeps only one copy", async () => {
  const twin = environment.nodes[1];
  const twinSession = await signIn(environment, twin);
  const owner = page.getByTestId("webhooks-owner-select");
  await owner.selectOption(twin.nodeId);
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#webhooksNew")!.disabled && document.querySelector<HTMLSelectElement>("#webhooksProject")!.options.length > 0);
  await page.getByTestId("webhooks-new-button").click();
  await page.getByTestId("webhooks-name-input").fill("Twin only");
  assert.equal(await page.getByTestId("webhooks-model-select").inputValue(), "", "changing owner clears previous model choices");
  await page.getByTestId("webhooks-harness-select").selectOption("pi");
  await page.getByTestId("webhooks-model-select").selectOption("dev-environment|dev-model");
  await page.getByTestId("webhooks-effort-select").selectOption("medium");
  await page.getByTestId("webhooks-tab-access").click();
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
  await page.getByTestId("webhooks-back-button").click();
  await page.getByTestId("webhooks-list").getByText("Twin only", { exact: true }).waitFor();
  await page.getByTestId("webhooks-open-button").click();
  await page.getByTestId("webhooks-form").waitFor({ state: "visible" });
  assert.equal(await owner.isVisible(), false, "editing cannot move or clone a webhook");
  await page.getByTestId("webhooks-tab-access").click();
  assert.equal(await page.getByTestId("webhooks-attachments-toggle").isChecked(), true);
  await page.getByTestId("webhooks-tab-setup").click();
  await page.getByTestId("webhooks-name-input").fill("Twin renamed");
  await page.getByTestId("webhooks-save-button").click();
  await until(async () => (await remoteHooks()).body.webhooks[0]?.name === "Twin renamed", "the twin webhook is renamed");
  await page.getByTestId("webhooks-back-button").click();
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
  assert.equal(await page.getByTestId("webhooks-title-template-input").isVisible(), false, "templates never rename existing-conversation targets");
  assert.equal(await page.getByTestId("webhooks-harness-select").inputValue(), engine);
  await page.getByTestId("webhooks-save-button").click();
  await page.getByTestId("webhooks-reveal").waitFor({ state: "visible" });
  const saved = (await hooks()).find(hook => hook.name === "Existing conversation")!;
  assert.equal(saved.target.engine, engine);
  await page.getByTestId("webhooks-reveal-done-button").click();
});

test("the page logged no unexpected errors", () => {
  assert.deepEqual(consoleErrors, []);
  assert.equal(expectedConsoleErrors.length, 1, "the UI surfaced the one intentional memory conflict");
});
