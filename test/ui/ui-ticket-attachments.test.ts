import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let syncthing: Server;
let browser: Browser;
let page: Page;
const failedResponses: string[] = [];
const consoleErrors: string[] = [];

async function startFakeSyncthing(): Promise<string> {
  syncthing = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/rest/config/folders") { response.end("[]"); return; }
    if (request.method === "POST" && request.url === "/rest/config/folders") { response.end("{}"); return; }
    if (request.method === "GET" && request.url === "/rest/system/status") { response.end('{"myID":"LOCAL"}'); return; }
    if (request.method === "GET" && request.url?.startsWith("/rest/db/ignores")) { response.end('{"ignore":[]}'); return; }
    if (request.method === "POST" && request.url?.startsWith("/rest/db/ignores")) { response.end("{}"); return; }
    response.statusCode = 404;
    response.end();
  });
  const port = await new Promise<number>((resolve) => syncthing.listen(0, "127.0.0.1", () => resolve((syncthing.address() as { port: number }).port)));
  return `http://127.0.0.1:${port}`;
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-ticket-attachments-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  const syncthingUrl = await startFakeSyncthing();
  server = await startDevNode(environment, node, { PI_MOBILE_WEB_SYNCTHING_URL: syncthingUrl, PI_MOBILE_WEB_SYNCTHING_API_KEY: "test-key" });
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: process.env.HEADED !== "1" });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  page.on("response", (response) => { if (response.status() >= 400) void response.text().then((body) => failedResponses.push(`${response.status()} ${response.request().method()} ${response.url()} ${body}`)); });
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (syncthing) await new Promise<void>((resolve, reject) => syncthing.close((error) => error ? reject(error) : resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});

async function signInAndOpenBoard(): Promise<void> {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  const project = page.locator(".project-card", { hasText: "Joint Bob" }).first();
  await project.waitFor({ timeout: 20_000 });
  await project.click();
  await page.getByTestId("chats-open-board-button").click();
}

test("a file attached to a ticket description survives saving and reopening", async () => {
  await signInAndOpenBoard();
  await page.getByTestId("board-add-backlog-button").click();
  await page.getByTestId("task-form-title-input").fill("Read attached runbook");
  await page.getByTestId("task-form-engine-select").selectOption("claude");
  await page.getByTestId("task-form-description-input").fill("Follow the runbook before changing code.");
  await page.getByTestId("task-form-attachment-input").setInputFiles({ name: "runbook.txt", mimeType: "text/plain", buffer: Buffer.from("deploy steps\n") });
  await page.locator("#taskAttachmentList .attachment-chip", { hasText: "runbook.txt" }).waitFor();
  assert.equal(await page.locator("#taskForm").evaluate((form: HTMLFormElement) => form.checkValidity()), true, "ticket form is valid");
  assert.equal(await page.getByTestId("task-form-save-button").isEnabled(), true, "ticket save is enabled");
  await page.getByTestId("task-form-save-button").click();

  const card = page.getByTestId("board-task-card").filter({ hasText: "Read attached runbook" });
  await card.waitFor({ timeout: 20_000 }).catch(async (error) => {
    const toast = await page.locator(".toast").allTextContents();
    const dialogOpen = await page.locator("#taskDialog[open]").count();
    const saveText = await page.getByTestId("task-form-save-button").textContent();
    const busy = await page.locator("#taskForm").getAttribute("aria-busy");
    throw new Error(`ticket was not rendered; dialogOpen=${dialogOpen}; save=${saveText}; busy=${busy}; toast=${JSON.stringify(toast)}; responses=${JSON.stringify(failedResponses)}; console=${JSON.stringify(consoleErrors)}`, { cause: error });
  });
  await card.getByTestId("board-task-open-ticket-button").click();
  const savedChip = page.locator("#taskAttachmentList .attachment-chip", { hasText: "runbook.txt" });
  await savedChip.waitFor({ timeout: 20_000 });
  assert.equal(await savedChip.count(), 1, "saved ticket renders one attachment chip");
});
