import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Page } from "playwright-core";
import { cleanTopic, ensureMemorySchema, recordRead, writeTopic, type ChangeMeta, type MemoryContext } from "../../src/control-center/memory-store.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

const bob = (why: string, text: string): ChangeMeta => ({ author: "bob", why, source: { kind: "chat", text, messageId: null, conversationId: null, projectId: null, projectName: "Joint Bob" } });

async function createTopic(page: Page, name: string, description: string, body: string, project = "") {
  await page.getByTestId("memory-new").click();
  await page.getByTestId("memory-name").fill(name);
  await page.getByTestId("memory-description").fill(description);
  if (project) await page.getByTestId("memory-project").selectOption(project);
  await page.getByTestId("memory-body").fill(body);
  await page.getByTestId("memory-save").click();
  await page.waitForFunction((text) => document.querySelector('[data-testid="memory-description-line"]')?.textContent === text, description);
}

const rowNames = (page: Page) => page.getByTestId("memory-topic").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.name));

test("Bob's memory tab: topics with links, search, paging, edit and delete; what Bob changed with keep, edit and revert; the ask-first switch; the project filter", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const [here, elsewhere] = node.projects;
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
  // The board is the only route faked: it gives the project filter something to show. Bob's memory is answered by the real server.
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      if (new URL(String(args[0]), location.href).pathname !== '/api/control-center/board') return originalFetch(...args);
      return new Response(JSON.stringify({ projects: [{ id: ${JSON.stringify(here.id)}, name: ${JSON.stringify(here.name)} }, { id: ${JSON.stringify(elsewhere.id)}, name: ${JSON.stringify(elsewhere.name)} }],
        cards: [{ projectId: ${JSON.stringify(here.id)}, projectName: ${JSON.stringify(here.name)}, conversationId: 'c1', sessionId: 'c1', path: '/c1', title: 'Mobile menu', column: 'running', agentId: 'claude', agentLabel: 'Claude', agentModel: null, executionNodeId: null, updatedAt: '2026-11-05T10:00:00Z', turnRunning: true, backgroundRunning: false, summary: 'Running', autoRespondActive: false },
          { projectId: ${JSON.stringify(elsewhere.id)}, projectName: ${JSON.stringify(elsewhere.name)}, conversationId: 'c2', sessionId: 'c2', path: '/c2', title: 'Slice 7', column: 'running', agentId: 'pi', agentLabel: 'Pi', agentModel: null, executionNodeId: null, updatedAt: '2026-11-05T09:00:00Z', turnRunning: true, backgroundRunning: false, summary: null, autoRespondActive: false }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  })()`);

  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-tab-memory").click();
  assert.match(await page.getByTestId("control-center-tabs").innerText(), /Bob's memory/);
  await page.getByTestId("memory-topic-list").getByText("Bob has not saved anything yet").waitFor();
  assert.equal(await page.getByTestId("memory-changes-count").isHidden(), true);

  // A topic is a name, one line and a text; a link to a topic that does not exist yet creates it.
  await createTopic(page, "Release gate", "Pushes need the token", "Push with the token. See [[how-ilia-works]].\nNever force-push main.", here.id);
  assert.deepEqual(await rowNames(page), ["release-gate"], "the name is made safe");
  assert.match(await page.getByTestId("memory-doc").innerText(), /release-gate[\s\S]*Pushes need the token[\s\S]*Never force-push main/);
  assert.equal(await page.getByTestId("memory-link").first().getAttribute("class"), "memory-link missing");
  await page.getByTestId("memory-link").first().click();
  assert.equal(await page.getByTestId("memory-name").inputValue(), "how-ilia-works");
  await page.getByTestId("memory-description").fill("Plans first, approves plans himself");
  await page.getByTestId("memory-body").fill("Plans before building.");
  await page.getByTestId("memory-save").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="memory-description-line"]')?.textContent === "Plans first, approves plans himself");
  assert.deepEqual((await rowNames(page)).sort(), ["how-ilia-works", "release-gate"]);
  assert.match(await page.getByTestId("memory-linked-from").innerText(), /release-gate/, "links show both ways");
  assert.equal(await page.getByTestId("control-tab-memory").locator(".control-tab-badge").innerText(), "2", "the tab counts topics");

  // Links between topics are clickable.
  await page.getByTestId("memory-linked-from").getByTestId("memory-link").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="memory-doc"] h3')?.textContent?.startsWith("release-gate"));
  await page.getByTestId("memory-text").getByTestId("memory-link").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="memory-doc"] h3')?.textContent === "how-ilia-works");

  // Search reads the text of topics too.
  await page.getByTestId("memory-search").fill("force-push");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="memory-topic"]').length === 1);
  assert.deepEqual(await rowNames(page), ["release-gate"]);
  await page.getByTestId("memory-search").fill("");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="memory-topic"]').length === 2);

  // Editing saves a change of your own, kept in the topic's history.
  await page.getByTestId("memory-topic").filter({ hasText: "how-ilia-works" }).click();
  await page.getByTestId("memory-edit").click();
  await page.getByTestId("memory-body").fill("Plans before building.\nApproves plans himself.");
  await page.getByTestId("memory-save").click();
  await page.getByTestId("memory-text").getByText("Approves plans himself.").waitFor();
  assert.equal(await page.getByTestId("memory-history").locator("li").count(), 2);
  assert.match(await page.getByTestId("memory-history").innerText(), /You · kept · You edited this topic/);

  // Delete asks first; cancelling keeps the topic, confirming removes it from the list but not from the history.
  await createTopic(page, "scratch", "A scratch topic", "Throw away.");
  await page.getByTestId("memory-delete").click();
  await page.getByTestId("confirm-dialog").waitFor({ state: "visible" });
  await page.getByTestId("confirm-cancel-button").click();
  assert.equal(await page.getByTestId("memory-topic").filter({ hasText: "scratch" }).count(), 1);
  await page.getByTestId("memory-delete").click();
  await page.getByTestId("confirm-accept-button").click();
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid="memory-topic"]')].some((row) => (row as HTMLElement).dataset.name === "scratch"));

  // The list pages instead of scrolling.
  const names = Array.from({ length: 14 }, (_, index) => `topic-${String(index + 1).padStart(2, "0")}`);
  await page.evaluate(async (list) => {
    const { api } = await import("/app/api.js");
    for (const name of list) await api("/api/control-center/memory/topics", { method: "POST", body: JSON.stringify({ name, description: `About ${name}`, body: `Text of ${name}.` }) });
  }, names);
  await page.getByTestId("control-tab-live").click();
  await page.getByTestId("control-tab-memory").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="memory-topic"]').length > 1);
  const shown = (await rowNames(page)).length;
  assert.ok(shown >= 3 && shown < 16, `the rows that fit the height are shown, not all 16: ${shown}`);
  assert.equal(await page.getByTestId("memory-topic-list").evaluate((list) => list.scrollHeight <= list.clientHeight + 1), true, "nothing scrolls");
  assert.equal(await page.getByTestId("memory-topics-page-label").textContent(), `1–${shown} of 16`);
  const firstPage = await rowNames(page);
  await page.getByTestId("memory-topics-page-next").click();
  await page.waitForFunction((first) => (document.querySelector('[data-testid="memory-topic"]') as HTMLElement | null)?.dataset.name !== first, firstPage[0]);
  assert.ok(!(await rowNames(page)).some((name) => firstPage.includes(name)), "the next page shows other topics");
  await page.getByTestId("memory-topics-page-previous").click();
  await page.waitForFunction((first) => (document.querySelector('[data-testid="memory-topic"]') as HTMLElement | null)?.dataset.name === first, firstPage[0]);

  // What Bob read for the last message is marked in the list.
  const memoryDirectory = path.join(node.dataDir, "control-center", "memory");
  const [account] = readdirSync(memoryDirectory);
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  db.exec("PRAGMA busy_timeout=5000");
  ensureMemorySchema(db);
  const ctx: MemoryContext = { db, accountId: account, root: path.join(memoryDirectory, account) };
  recordRead(ctx, ["release-gate"], "how do I push release 2.3?");
  await page.getByTestId("memory-search").fill("release");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="memory-topic"]').length === 1);
  assert.equal(await page.getByTestId("memory-read").textContent(), "read for your last message");
  assert.match(await page.getByTestId("memory-last-read").innerText(), /how do I push release 2\.3\?.*release-gate/);
  await page.getByTestId("memory-search").fill("");

  // Bob's changes: one written and waiting for a look, one proposed and waiting for an OK, and one on a topic you can still read.
  writeTopic(ctx, cleanTopic("automations-conventions", { description: "Daily reports run on the homeserver", body: "Daily reports run at 07:00." }), bob("You set up the slow query report", "the daily report runs on the homeserver at 7"));
  writeTopic(ctx, cleanTopic("release-gate", { description: "Pushes need the token", body: "Push with the token. See [[how-ilia-works]].\nNever force-push main.\nThe first push is blocked once.", project: here.id }), bob("You corrected Bob twice", "the first push is always blocked, push again"), true);
  writeTopic(ctx, cleanTopic("mobile-ui", { description: "Menu favourites", body: "Mark done, note." }), bob("From the mobile menu chat", "tools and costs are out of the menu"));
  await page.setViewportSize({ width: 1440, height: 1500 });
  await page.getByTestId("memory-sub-changes").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="memory-change"]').length > 3);
  assert.equal(await page.getByTestId("memory-changes-count").textContent(), "3", "three changes wait for you");
  const cards = page.getByTestId("memory-change");
  assert.equal(await cards.first().getAttribute("data-topic"), "mobile-ui", "newest first");
  assert.equal(await page.getByTestId("memory-change-list").evaluate((list) => list.scrollHeight <= list.clientHeight + 1), true, "the changes page instead of scrolling");

  const pending = page.locator('[data-testid="memory-change"][data-topic="release-gate"][data-status="pending"]');
  assert.equal(await pending.getByTestId("memory-change-status").textContent(), "Waiting for you");
  assert.deepEqual(await pending.locator(".memory-diff-line").allTextContents(), ["+ The first push is blocked once."], "only what the proposal adds");
  assert.match(await pending.getByTestId("memory-change-source").textContent() ?? "", /From your message “the first push is always blocked, push again” in chat with Bob \(Joint Bob\) · why: You corrected Bob twice/);
  assert.deepEqual(await pending.locator("button").allTextContents(), ["Keep", "Edit", "Revert"]);
  assert.doesNotMatch(readFileSync(path.join(ctx.root, "release-gate.md"), "utf8"), /blocked once/, "a waiting proposal has not touched the topic");

  // Keep writes it.
  await pending.getByTestId("memory-keep").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="memory-change"][data-topic="release-gate"]')?.getAttribute("data-status") === "kept");
  assert.match(readFileSync(path.join(ctx.root, "release-gate.md"), "utf8"), /The first push is blocked once/);
  assert.equal(await page.getByTestId("memory-changes-count").textContent(), "2");

  // Edit: change what Bob wrote, and the edit is a change of yours.
  const written = page.locator('[data-testid="memory-change"][data-topic="automations-conventions"]');
  assert.equal(await written.getByTestId("memory-change-status").textContent(), "To review");
  await written.getByTestId("memory-edit-change").click();
  assert.equal(await written.getByTestId("memory-change-body").inputValue(), "Daily reports run at 07:00.");
  await written.getByTestId("memory-change-body").fill("Daily reports run at 07:00 on the homeserver.");
  await written.getByTestId("memory-change-save").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="memory-change"][data-topic="automations-conventions"][data-status="kept"]'));
  assert.match(readFileSync(path.join(ctx.root, "automations-conventions.md"), "utf8"), /07:00 on the homeserver\./);
  assert.match(await page.getByTestId("memory-change").first().getByTestId("memory-change-source").textContent() ?? "", /^You · You edited what Bob saved/);

  // Revert takes a new topic away again, and the change keeps its history.
  const created = page.locator('[data-testid="memory-change"][data-topic="mobile-ui"]');
  await created.getByTestId("memory-revert").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="memory-change"][data-topic="mobile-ui"]')?.getAttribute("data-status") === "reverted");
  assert.equal(existsSync(path.join(ctx.root, "mobile-ui.md")), false);
  assert.equal(await created.locator("button").count(), 0, "a reverted change has nothing left to press");
  assert.equal(await page.getByTestId("memory-changes-count").isHidden(), true);

  // Reverting something already kept asks first, then restores the earlier text.
  await page.locator('[data-testid="memory-change"][data-topic="release-gate"][data-status="kept"]').first().getByTestId("memory-revert").click();
  await page.getByTestId("confirm-accept-button").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="memory-change"][data-topic="release-gate"]')?.getAttribute("data-status") === "reverted");
  assert.doesNotMatch(readFileSync(path.join(ctx.root, "release-gate.md"), "utf8"), /blocked once/);

  // The history pages too.
  const total = Number((await page.getByTestId("memory-changes-page-label").textContent())!.split(" of ")[1]);
  assert.ok(total > 15, `every change is kept, ${total}`);
  const firstCard = await page.getByTestId("memory-change").first().getAttribute("data-id");
  await page.getByTestId("memory-changes-page-next").click();
  await page.waitForFunction((id) => document.querySelector('[data-testid="memory-change"]')?.getAttribute("data-id") !== id, firstCard);
  await page.getByTestId("memory-changes-page-previous").click();
  await page.waitForFunction((id) => document.querySelector('[data-testid="memory-change"]')?.getAttribute("data-id") === id, firstCard);

  // The switch is Bob's own "ask before saving" setting.
  assert.equal(await page.getByTestId("memory-ask-before").isChecked(), false);
  await page.getByTestId("memory-ask-before").check();
  await page.waitForFunction(async () => (await (await fetch("/api/control-center/bob/settings")).json()).askBeforeSaving === true);
  await page.getByTestId("control-tab-live").click();
  await page.getByTestId("control-tab-memory").click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="memory-ask-before"]') as HTMLInputElement).checked);
  await page.getByTestId("memory-ask-before").uncheck();
  await page.waitForFunction(async () => (await (await fetch("/api/control-center/bob/settings")).json()).askBeforeSaving === false);

  // Topics about a project follow the board's project filter; topics about no project always show.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("memory-sub-topics").click();
  await page.evaluate(async (project) => {
    const { api } = await import("/app/api.js");
    await api("/api/control-center/memory/topics", { method: "POST", body: JSON.stringify({ name: "elsewhere-only", description: "About the other project", body: "Only there.", project }) });
  }, elsewhere.id);
  await page.getByTestId("control-tab-live").click();
  await page.getByTestId("control-center-filters").getByText(here.name, { exact: true }).click();
  await page.getByTestId("control-tab-memory").click();
  await page.getByTestId("memory-search").fill("elsewhere");
  await page.waitForFunction(() => document.querySelector('[data-testid="memory-topic-list"]')?.textContent?.includes("No topic matches"));
  await page.getByTestId("memory-search").fill("release");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="memory-topic"]').length === 1);
  assert.deepEqual(await rowNames(page), ["release-gate"], "a topic tagged with the selected project shows");
  await page.getByTestId("memory-search").fill("topic-0");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="memory-topic"]').length > 1);
  assert.ok((await rowNames(page)).every((name) => name?.startsWith("topic-")), "topics about no project show");
  assert.match(await page.getByTestId("memory-filter-note").innerText(), new RegExp(here.name));
  await page.getByTestId("control-tab-live").click();
  await page.getByTestId("control-center-filters").getByText("All", { exact: true }).click();
  await page.getByTestId("control-tab-memory").click();
  await page.getByTestId("memory-search").fill("elsewhere");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="memory-topic"]').length === 1);
  assert.equal(await page.getByTestId("memory-filter-note").isHidden(), true);
});
