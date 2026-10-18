import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode, api } from "../dev-nodes.js";
import { launchChrome } from "./launch-chrome.js";

test("installed share target keeps text, URL and screenshot together for review before saving", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-share-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    const projectId = node.projects[0].id;
    const listed = await api<{ sessions: Array<{ id: string; harnessId: string }> }>(node, session, "GET", `/projects/${projectId}/sessions`);
    const conversation = listed.body.sessions[0];
    const created = await api<{ assistant: { id: string } }>(node, session, "POST", "/personal-assistants", { projectId, engine: conversation.harnessId, sessionId: conversation.id, name: "Shopping", instructions: "" });
    assert.equal(created.status, 201);
    browser = await launchChrome({ headless: true });
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const page = await context.newPage();
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.waitForFunction(() => navigator.serviceWorker?.controller);
    const target = await page.evaluate(async () => {
      const form = new FormData();
      form.append("title", "Shared phone"); form.append("url", "https://example.test/shared-phone");
      form.append("text", "Warranty included"); form.append("images", new File(["fixture"], "screen.png", { type: "image/png" }));
      const response = await fetch("/assistant-share", { method: "POST", body: form });
      return response.url;
    });
    assert.match(target, /assistant\.html\?share=/);
    const url = new URL(target); url.searchParams.set("id", created.body.assistant.id);
    await page.goto(url.toString());
    await page.locator("#heading").getByText("Shopping").waitFor();
    assert.equal(await page.locator("#title").inputValue(), "Shared phone");
    assert.equal(await page.locator("#url").inputValue(), "https://example.test/shared-phone");
    assert.equal(await page.locator("#note").inputValue(), "Warranty included");
    await page.getByText("1 shared screenshot(s) ready. Review and save.").waitFor();
    await page.locator("#capture button").click();
    await page.locator("#message").getByText("Item saved", { exact: true }).waitFor();
    await page.locator("#items article img").waitFor();
    assert.equal(await page.locator("#items article img").count(), 1);
  } finally { await browser?.close(); if (server) await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
