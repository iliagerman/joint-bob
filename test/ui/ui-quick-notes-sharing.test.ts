import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, pairTwinNodes, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("Notes shows shared drafts and saves edits on their home node", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-notes-sharing-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  let browser: Browser | undefined;
  try {
    const env = await seedDevEnvironment(root, 2), [a, b] = env.nodes;
    for (const node of env.nodes) children.push(await startDevNode(env, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") }));
    await pairTwinNodes(env);
    const sa = await signIn(env, a), sb = await signIn(env, b);
    const projectId = projectNamed(a, "Internal Assistant").id;
    const created = await api<{ note: { id: string } }>(a, sa, "POST", "/quick-notes", { projectId, title: "Draft from other machine", content: "Shared original", harnessId: "pi" });
    assert.equal(created.status, 201);
    browser = await launchChrome({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const separator = sb.cookie.indexOf("=");
    await context.addCookies([{ name: sb.cookie.slice(0, separator), value: sb.cookie.slice(separator + 1), url: b.url }]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(b.url, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-project-id="${projectId}"] .project-card`).click();
    await page.getByTestId("session-list-loading-bar").waitFor({ state: "hidden" });
    await page.getByTestId("notes-tab").click();
    const row = page.getByTestId("quick-note-row").filter({ hasText: "Draft from other machine" });
    await row.click();
    await page.waitForFunction(id => (document.querySelector("#quickNoteNode") as HTMLSelectElement)?.value === id, a.nodeId);
    assert.equal(await page.getByTestId("quick-note-content-input").inputValue(), "Shared original");
    await page.getByTestId("quick-note-content-input").fill("Edited on the viewing machine");
    await page.getByTestId("quick-note-save-button").click();
    await page.getByTestId("quick-note-dialog").waitFor({ state: "hidden" });
    const saved = await api<{ note: { content: string; nodeId: string } }>(a, sa, "GET", `/quick-notes/${created.body.note.id}`);
    assert.equal(saved.body.note.content, "Edited on the viewing machine");
    assert.equal(saved.body.note.nodeId, a.nodeId, "editing from a peer must preserve the original default execution node");
    const item = page.locator(".quick-note-row-wrap").filter({ has: row });
    await item.getByTestId("quick-note-quick-delete-button").click();
    await page.getByTestId("confirm-accept-button").click();
    await row.waitFor({ state: "detached" });
    assert.equal((await api(a, sa, "GET", `/quick-notes/${created.body.note.id}`)).status, 404);
  } finally {
    await browser?.close();
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
