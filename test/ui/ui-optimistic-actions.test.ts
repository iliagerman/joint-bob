import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser, type Route } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import type { SessionSummary } from "../../src/types.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

/** Holds every matching request until the test lets it through, or answers it with an error. */
function gate() {
  const held: Route[] = [];
  return {
    handle: (route: Route) => { held.push(route); },
    count: () => held.length,
    pass: async () => { for (const route of held.splice(0)) await route.continue(); },
    refuse: async (error: string) => { for (const route of held.splice(0)) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error }) }); },
  };
}

// A done mark or a removal waited for the server, which on a busy node took seconds; the row
// now changes on the click, survives a list refresh already in flight, and comes back on a refusal.
test("conversation actions change the row before the server answers and undo on a refusal", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-optimistic-ui-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    const auth = await signIn(environment, node);
    const project = node.projects.find((entry) => entry.name === "Internal Assistant")!;
    const sessions = (await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${project.id}/sessions`)).body.sessions;
    const target = sessions.find((entry) => entry.title === "Thread-Based Agent Builder");
    assert.ok(target, "the seeded conversation is present");

    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: project.name }).first().click();
    const rows = page.locator("#sessionList .session-card");
    await rows.first().waitFor();
    const row = page.locator(`#sessionList [data-session-path="${target.path}"]`);
    await row.waitFor();

    const done = gate();
    await page.route("**/sessions/done", done.handle);
    await row.getByTestId("session-menu-button").click();
    await page.getByTestId("session-done-button").click();
    await row.waitFor({ state: "detached" });
    assert.equal(done.count(), 1, "the row left the list while the server had not answered");
    // A list asked for before the server saved the mark must not bring the row back.
    await page.evaluate(async () => (await import("/app/socket.js")).refreshSessionsQuietly());
    assert.equal(await row.count(), 0, "a refresh in flight keeps the pending mark");
    await done.pass();
    await page.waitForResponse((response) => response.url().endsWith("/sessions/done"));

    await page.getByTestId("show-done-conversations-toggle").check();
    await row.locator(".session-done-badge").waitFor();
    await row.getByTestId("session-menu-button").click();
    await page.getByTestId("session-done-button").click();
    await row.locator(".session-done-badge").waitFor({ state: "detached" });
    await done.refuse("Done marks are unavailable");
    await page.getByText("Could not reopen the conversation: Done marks are unavailable", { exact: true }).waitFor();
    await row.locator(".session-done-badge").waitFor();
    await page.unroute("**/sessions/done");

    const removal = gate();
    await page.route(`**/api/projects/${project.id}/sessions?sessionId=*`, (route) => route.request().method() === "DELETE" ? removal.handle(route) : route.continue());
    await row.getByTestId("session-menu-button").click();
    await page.getByTestId("session-remove-button").click();
    await page.locator("#confirmDialog[open]").waitFor();
    await page.locator("#confirmAcceptButton").click();
    await row.waitFor({ state: "detached" });
    assert.equal(removal.count(), 1, "the row left the list while the delete was in flight");
    await removal.refuse("Conversation owner is unavailable");
    await page.getByText("Could not remove the conversation: Conversation owner is unavailable", { exact: true }).waitFor();
    await row.waitFor();
    assert.equal((await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${project.id}/sessions`)).body.sessions.some((entry) => entry.path === target.path), true, "nothing was deleted");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
