import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode } from "../dev-nodes.js";

let root: string;
let server: ChildProcess;
let browser: Browser;
let page: Page;
let node: SeededNode;
let imagePath: string;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-chat-thumbnails-"));
  const environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  imagePath = path.join(node.projects[0].path, ".joint-bob-attachments", "example.png");
  await mkdir(path.dirname(imagePath), { recursive: true });
  await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  server = await startDevNode(environment, node);
  const session = await signIn(environment, node);
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: true });
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

test("live and loaded image attachments render as thumbnails and expand on click", async () => {
  await page.evaluate(async ({ projectId, nodeId, attachedPath }) => {
    const transcript = await import("/app/chat-transcript.js");
    const { state } = await import("/app/state.js");
    state.activeProjectId = projectId;
    state.activeNodeId = nodeId;
    transcript.clearChat();
    transcript.appendMessage("user", `Please inspect this\n\nImage attachments:\n- example.png: ${attachedPath}\nAnalyze them alongside the request. Use these paths when a tool needs the original image file.`, false);
    transcript.appendMessage("user", "Another image\n\nAttached: example.png", false, [{ kind: "image", name: "example.png", path: attachedPath }]);
  }, { projectId: node.projects[0].id, nodeId: node.nodeId, attachedPath: imagePath });

  const thumbnails = page.getByTestId("message-image-thumbnail");
  await thumbnails.last().waitFor();
  assert.equal(await thumbnails.count(), 2, "loaded and live messages both show their image");
  assert.equal(await thumbnails.first().getAttribute("aria-label"), "Expand example.png");
  await thumbnails.first().locator("img").evaluate((image) => image.decode());
  assert.equal(await thumbnails.first().locator("img").evaluate((image) => image.complete && image.naturalWidth > 0), true, "thumbnail loads image bytes");
  assert.match(await page.locator(".message.user").first().innerText(), /Attached: example\.png/);
  assert.doesNotMatch(await page.locator(".message.user").first().innerText(), /Analyze them alongside/);

  await thumbnails.first().click();
  const viewer = page.getByTestId("message-image-viewer");
  await viewer.waitFor({ state: "visible" });
  assert.equal(await viewer.locator("img").getAttribute("alt"), "example.png");
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "hidden" });
});
