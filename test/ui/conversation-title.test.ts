import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-conversation-title-ui-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);

  const session = await signIn(environment, node);
  const renamed = await api(node, session, "PUT", `/projects/${node.projects[0].id}/sessions/title`, {
    sessionId: "thread-based-agent-builder",
    engine: "pi",
    title: "My chosen conversation name",
  });
  assert.equal(renamed.status, 200);

  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: process.env.HEADED !== "1" });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript({ content: `
    const nativeAddEventListener = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function (type, listener, options) {
      if (type !== "message") return nativeAddEventListener.call(this, type, listener, options);
      const wrapped = function (event) {
        const payload = JSON.parse(String(event.data));
        const delivered = payload.type === "ready" && payload.sessionFile
          ? new MessageEvent("message", { data: JSON.stringify({ ...payload, sessionFile: payload.sessionFile + ".moved" }) })
          : event;
        if (typeof listener === "function") listener.call(this, delivered);
        else listener.handleEvent(delivered);
      };
      return nativeAddEventListener.call(this, type, wrapped, options);
    };
  ` });
  page = await context.newPage();
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("the chat header keeps the chosen name when a draft gains its transcript path", async () => {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();

  const conversation = page.locator(".session-card", { hasText: "My chosen conversation name" }).first();
  await conversation.waitFor({ timeout: 20_000 });
  await conversation.click();
  await page.waitForFunction(() => !(document.querySelector("#messageInput") as HTMLTextAreaElement).disabled);

  assert.equal(await page.locator("#sessionTitle").innerText(), "My chosen conversation name");
});
