import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type BrowserContext, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "../dev-nodes.js";

const NOTE_IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

/** datetime-local values carry no seconds or zone, so the test writes the exact local string it expects back. */
function localDatetimeValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let authSession: SignedIn;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-quick-notes-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") });
  const session = await signIn(environment, node);
  authSession = session;
  browser = await launchChrome({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const separator = session.cookie.indexOf("=");
  await context.addCookies([{ name: session.cookie.slice(0, separator), value: session.cookie.slice(separator + 1), url: node.url }]);
  page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.getByText("Internal Assistant", { exact: true }).waitFor();
}, { timeout: 180_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("mobile keeps creation actions together and switches conversations and notes with tabs", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  const projectId = node.projects.find((project) => project.name === "Internal Assistant")!.id;
  await page.locator(`[data-project-id="${projectId}"] .project-card`).click();
  await page.getByTestId("session-list-loading-bar").waitFor({ state: "hidden" });

  await page.getByTestId("nav-projects-button").click();
  const projectQuickNote = page.getByTestId("projects-quick-note-create-button");
  assert.equal(await projectQuickNote.isVisible(), true, "Projects has a mobile quick-note action");
  await projectQuickNote.click();
  await page.getByTestId("quick-note-dialog").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("quick-note-project-select").inputValue(), projectId, "the Projects action uses the active project");
  await page.getByTestId("quick-note-cancel-button").click();
  await page.getByTestId("nav-chats-button").click();

  const newConversation = page.getByTestId("new-conversation-mobile-button");
  const newNote = page.getByTestId("quick-note-create-mobile-button");
  const [conversationBox, noteBox] = await Promise.all([newConversation.boundingBox(), newNote.boundingBox()]);
  assert.ok(conversationBox && noteBox, "both mobile creation actions are visible");
  assert.ok(Math.abs(conversationBox.y - noteBox.y) < 2, "mobile creation actions share one row");

  const conversationsTab = page.getByTestId("conversations-tab");
  const notesTab = page.getByTestId("notes-tab");
  assert.equal(await conversationsTab.getAttribute("aria-selected"), "true", "conversations is the default tab");
  assert.equal(await page.getByTestId("conversation-list-pane").isVisible(), true);
  assert.equal(await page.getByTestId("quick-notes-section").isVisible(), false);

  await notesTab.click();
  assert.equal(await notesTab.getAttribute("aria-selected"), "true");
  assert.equal(await page.getByTestId("conversation-list-pane").isVisible(), false);
  assert.equal(await page.getByTestId("quick-notes-section").isVisible(), true);
  await conversationsTab.click();
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("a quick note can move, start a conversation, and be deleted", async () => {
  const activeProjectId = node.projects.find((project) => project.name === "Internal Assistant")!.id;
  await page.locator(`[data-project-id="${activeProjectId}"] .project-card`).click();
  await page.getByTestId("session-list-loading-bar").waitFor({ state: "hidden" });
  const conversationCount = await page.locator("#sessionList .session-card").count();

  const notesSection = page.getByTestId("quick-notes-section");
  const notesShortcut = page.getByTestId("projects-open-notes-button");
  assert.equal(await notesShortcut.isVisible(), true, "the hidden Board action is replaced by Notes");
  assert.equal(await notesShortcut.locator(".shortcut-hint").count(), 1, "the Notes action advertises its shortcut");
  await notesShortcut.click();
  const projectFilter = page.getByTestId("quick-notes-project-filter");
  assert.equal(await projectFilter.inputValue(), activeProjectId, "Notes defaults to the active project");
  assert.equal(await page.getByTestId("notes-tab").getAttribute("aria-selected"), "true");
  await page.keyboard.press("Control+Alt+/");
  await notesSection.waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("conversations-tab").getAttribute("aria-selected"), "true");
  await page.keyboard.press("Control+Alt+/");
  await notesSection.waitFor({ state: "visible" });

  const button = page.getByTestId("quick-note-create-button");
  assert.equal(await button.evaluate((element) => element.closest("#quickNotesSection") !== null), true, "add note belongs to Notes, not the harness row");
  assert.equal(await button.locator(".shortcut-hint").count(), 1, "quick note button advertises its shortcut");
  await page.keyboard.press("Control+Alt+.");
  await page.locator("#quickNoteDialog[open]").waitFor();
  assert.equal(await page.getByTestId("quick-note-project-select").inputValue(), activeProjectId);
  await page.getByTestId("quick-note-title-input").fill("Verify release smoke test");
  await page.getByTestId("quick-note-content-input").fill("Do this manually after deploy.");
  await page.getByTestId("quick-note-save-button").click();

  const row = page.getByTestId("quick-note-row").filter({ hasText: "Verify release smoke test" });
  await row.waitFor();
  assert.equal(await page.locator("#sessionList .session-card").count(), conversationCount, "saving a note does not create a conversation");

  await row.click();
  await page.getByTestId("quick-note-project-select").selectOption({ label: "Joint Bob" });
  await page.getByTestId("quick-note-save-button").click();
  await row.waitFor({ state: "detached" });

  const jointBobId = node.projects.find((project) => project.name === "Joint Bob")!.id;
  await projectFilter.selectOption(jointBobId);
  assert.equal(await page.locator("#projectName").textContent(), "Internal Assistant", "filtering notes does not change the active project");
  const movedRow = page.getByTestId("quick-note-row").filter({ hasText: "Verify release smoke test" });
  await movedRow.waitFor();
  const movedItem = page.locator(".quick-note-row-wrap").filter({ has: movedRow });
  assert.equal(await movedItem.getByTestId("quick-note-start-button").isVisible(), true, "each note has a start shortcut");

  await page.locator(`[data-project-id="${jointBobId}"] .project-card`).click();
  assert.equal(await page.getByTestId("conversations-tab").getAttribute("aria-selected"), "true", "a project opens on conversations");
  await page.getByTestId("notes-tab").click();
  await movedRow.waitFor();
  await movedRow.click();
  assert.equal(await page.getByTestId("quick-note-convert-button").isVisible(), true, "the note dialog can start a conversation");
  await page.getByTestId("quick-note-cancel-button").click();
  await movedItem.getByTestId("quick-note-start-button").click();
  await page.locator("#messages .message.user").filter({ hasText: "Do this manually after deploy." }).waitFor();
  await movedRow.waitFor({ state: "detached" });

  await page.getByTestId("quick-note-create-button").click();
  await page.getByTestId("quick-note-title-input").fill("Delete this note");
  await page.getByTestId("quick-note-save-button").click();
  const disposable = page.locator(".quick-note-row-wrap").filter({ hasText: "Delete this note" });
  await disposable.getByTestId("quick-note-quick-delete-button").click();
  await page.getByTestId("confirm-accept-button").click();
  await disposable.waitFor({ state: "detached" });
});

async function openNotesTab(projectId: string) {
  await page.locator(`[data-project-id="${projectId}"] .project-card`).click();
  await page.getByTestId("session-list-loading-bar").waitFor({ state: "hidden" });
  await page.getByTestId("notes-tab").click();
  await page.getByTestId("quick-notes-section").waitFor({ state: "visible" });
}

test("a note keeps its node, secrets, schedule, and images across save and reopen", async () => {
  const projectId = node.projects.find((project) => project.name === "Internal Assistant")!.id;
  const account = await api<{ account: { id: string } }>(node, authSession, "POST", "/secrets/accounts", {
    label: "Note pin secrets",
    provider: "custom",
    variables: [{ name: "NOTE_PIN", kind: "value", value: "1" }],
  });
  assert.equal(account.status, 201, "the pinned secret account must exist");
  const nodes = await api<{ nodes: Array<{ id: string; local: boolean }> }>(node, authSession, "GET", `/projects/${projectId}/session-nodes`);
  const localNodeId = nodes.body.nodes.find((entry) => entry.local)!.id;

  await openNotesTab(projectId);
  await page.getByTestId("quick-note-create-button").click();
  await page.locator("#quickNoteDialog[open]").waitFor();
  await page.getByTestId("quick-note-title-input").fill("Pin launch context");
  await page.getByTestId("quick-note-content-input").fill("Start later with these credentials.");
  const due = new Date(Date.now() + 45 * 60_000);
  const dueValue = localDatetimeValue(due);
  await page.getByTestId("quick-note-schedule-input").fill(dueValue);
  await page.waitForFunction((id) => document.querySelector("#quickNoteNode").value === id, localNodeId);
  assert.equal(await page.getByTestId("quick-note-node-select").inputValue(), localNodeId, "a new note defaults to this node");
  const secret = page.getByTestId("quick-note-secret-checkbox");
  await secret.check();
  await page.getByTestId("quick-note-image-input").setInputFiles({ name: "pin.png", mimeType: "image/png", buffer: NOTE_IMAGE });
  const chip = page.getByTestId("quick-note-image-list").locator(".attachment-chip");
  await chip.waitFor();
  assert.match(await chip.innerText(), /pin\.png/, "the picked image previews before saving");
  assert.equal(await chip.getByTestId("attachment-thumbnail").count(), 1, "the chip shows the image bytes");
  await page.getByTestId("quick-note-save-button").click();

  const listed = await api<{ notes: Array<{ id: string; title: string; nodeId: string | null; secretAccountIds: string[]; scheduledAt: string | null; images: Array<{ kind: string; name: string; mimeType: string; data: string }> }> }>(
    node, authSession, "GET", `/projects/${projectId}/quick-notes`);
  const saved = listed.body.notes.find((note) => note.title === "Pin launch context");
  assert.ok(saved, "the note saved");
  assert.equal(saved.nodeId, localNodeId, "the pinned node persists");
  assert.deepEqual(saved.secretAccountIds, [account.body.account.id], "the ticked secret account persists");
  assert.equal(saved.scheduledAt, new Date(dueValue).toISOString(), "the local schedule converts to an exact ISO instant");
  assert.equal(saved.images.length, 1, "the attached image persists");
  assert.equal(saved.images[0].kind, "image");
  assert.equal(saved.images[0].name, "pin.png");
  assert.equal(saved.images[0].mimeType, "image/png");
  assert.ok(saved.images[0].data.length > 0, "the image bytes persist as base64");

  const row = page.getByTestId("quick-note-row").filter({ hasText: "Pin launch context" });
  await row.click();
  await page.locator("#quickNoteDialog[open]").waitFor();
  await page.waitForFunction((id) => document.querySelector("#quickNoteNode").value === id, localNodeId);
  assert.equal(await page.getByTestId("quick-note-node-select").inputValue(), localNodeId, "the saved node is reselected");
  assert.equal(await page.getByTestId("quick-note-secret-checkbox").isChecked(), true, "the saved secret stays ticked");
  assert.equal(await page.getByTestId("quick-note-schedule-input").inputValue(), dueValue, "the saved schedule round-trips in local time");
  const reopenedChip = page.getByTestId("quick-note-image-list").locator(".attachment-chip");
  await reopenedChip.waitFor();
  assert.match(await reopenedChip.innerText(), /pin\.png/, "the saved image reopens with the note");

  await reopenedChip.getByTestId("attachment-remove-button").click();
  assert.equal(await page.getByTestId("quick-note-image-list").locator(".attachment-chip").count(), 0, "removing the image clears the preview");
  await page.getByTestId("quick-note-save-button").click();
  const afterRemove = await api<{ notes: Array<{ id: string; images: unknown[] }> }>(node, authSession, "GET", `/projects/${projectId}/quick-notes`);
  assert.equal(afterRemove.body.notes.find((note) => note.id === saved.id)?.images.length, 0, "the removed image is not saved");
  await row.click();
  await page.locator("#quickNoteDialog[open]").waitFor();
  await page.waitForFunction((id) => document.querySelector("#quickNoteNode").value === id, localNodeId);
  assert.equal(await page.getByTestId("quick-note-image-list").locator(".attachment-chip").count(), 0, "a reopened note shows no images once removed");
  await page.getByTestId("quick-note-cancel-button").click();
  await fetch(`${node.url}/api/quick-notes/${saved.id}`, { method: "DELETE", headers: { Cookie: authSession.cookie, "x-csrf-token": authSession.csrfToken } });
});

test("saved launch options cannot be erased while loading and unchecked secrets stay unchecked", async () => {
  const projectId = node.projects[0].id;
  const account = await api<{ account: { id: string } }>(node, authSession, "POST", "/secrets/accounts", { label: "Slow options", provider: "custom", variables: [{ name: "SLOW_TEST", kind: "value", value: "fixture" }] });
  const saved = await api<{ note: { id: string } }>(node, authSession, "POST", "/quick-notes", { projectId, title: "Slow draft", content: "", harnessId: "pi", nodeId: node.nodeId, secretAccountIds: [account.body.account.id] });
  await openNotesTab(projectId);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/session-nodes", async route => { await gate; await route.continue(); });
  try {
    await page.getByTestId("quick-note-row").filter({ hasText: "Slow draft" }).click();
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("#quickNoteHarness")!.options.length > 0);
    assert.equal(await page.getByTestId("quick-note-save-button").isDisabled(), true, "save must wait for saved node and accounts to load");
    assert.equal(await page.getByTestId("quick-note-convert-button").isDisabled(), true, "start must wait for launch options");
    release();
    const checkbox = page.locator(`#quickNoteSecretList input[value="${account.body.account.id}"]`);
    await checkbox.waitFor();
    await checkbox.uncheck();
    await page.getByTestId("quick-note-node-select").dispatchEvent("change");
    assert.equal(await checkbox.isChecked(), false, "changing node must not resurrect an unchecked saved account");
    await page.getByTestId("quick-note-save-button").click();
    await page.getByTestId("quick-note-dialog").waitFor({ state: "hidden" });
    const current = await api<{ note: { nodeId: string; secretAccountIds: string[] } }>(node, authSession, "GET", `/quick-notes/${saved.body.note.id}`);
    assert.equal(current.body.note.nodeId, node.nodeId);
    assert.deepEqual(current.body.note.secretAccountIds, []);
  } finally {
    release();
    await page.unroute("**/session-nodes");
    await page.evaluate(() => document.querySelector<HTMLDialogElement>("#quickNoteDialog")!.close());
    await fetch(`${node.url}/api/quick-notes/${saved.body.note.id}`, { method: "DELETE", headers: { Cookie: authSession.cookie, "x-csrf-token": authSession.csrfToken } });
  }
});

test("the notes queue is an explicit node-wide opt-in with a bounded parallel limit", async () => {
  const projectId = node.projects.find((project) => project.name === "Internal Assistant")!.id;
  await openNotesTab(projectId);
  const toggle = page.getByTestId("quick-notes-queue-enabled");
  const parallel = page.getByTestId("quick-notes-queue-parallel");
  assert.equal(await toggle.isChecked(), false, "the queue is disabled until it is switched on");
  assert.equal(await parallel.inputValue(), "1", "one conversation at a time is the default");
  assert.match(await page.getByTestId("quick-notes-queue-hint").innerText(), /every project on this node/, "the control says it is node-wide");

  await toggle.check();
  const enabled = await api<{ queue: { enabled: boolean; maxParallel: number } }>(node, authSession, "GET", "/quick-notes/queue");
  assert.deepEqual(enabled.body.queue, { enabled: true, maxParallel: 1 }, "opting in persists immediately");

  await parallel.fill("25");
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => document.querySelector("#quickNotesQueueParallel").value === "20");
  const clamped = await api<{ queue: { enabled: boolean; maxParallel: number } }>(node, authSession, "GET", "/quick-notes/queue");
  assert.equal(clamped.body.queue.maxParallel, 20, "the parallel limit is capped at 20");

  await parallel.fill("0");
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => document.querySelector("#quickNotesQueueParallel").value === "1");
  const floored = await api<{ queue: { enabled: boolean; maxParallel: number } }>(node, authSession, "GET", "/quick-notes/queue");
  assert.equal(floored.body.queue.maxParallel, 1, "the parallel limit never drops below 1");
});

test("a scheduled note waits for its time instead of starting with the queue", async () => {
  const projectId = node.projects.find((project) => project.name === "Internal Assistant")!.id;
  const applied = await api<{ queue: { enabled: boolean; maxParallel: number } }>(node, authSession, "PUT", "/quick-notes/queue", { queue: { enabled: true, maxParallel: 1 } });
  assert.deepEqual(applied.body.queue, { enabled: true, maxParallel: 1 });

  await openNotesTab(projectId);
  await page.getByTestId("quick-note-create-button").click();
  await page.locator("#quickNoteDialog[open]").waitFor();
  await page.getByTestId("quick-note-title-input").fill("Hold for the morning");
  await page.getByTestId("quick-note-content-input").fill("Nothing starts before the due time.");
  const dueValue = localDatetimeValue(new Date(Date.now() + 60 * 60_000));
  await page.getByTestId("quick-note-schedule-input").fill(dueValue);
  await page.getByTestId("quick-note-save-button").click();
  const row = page.getByTestId("quick-note-row").filter({ hasText: "Hold for the morning" });
  await row.waitFor();
  assert.match(await row.getByTestId("quick-note-schedule-badge").innerText(), /waits until/i, "the row shows it is waiting");

  // The visible Notes tab polls, and a future note must survive every poll without starting.
  let polls = 0;
  const countPoll = (request: import("playwright-core").Request) => {
    if (request.url().includes(`/api/projects/${projectId}/quick-notes`)) polls += 1;
  };
  page.on("request", countPoll);
  await page.waitForTimeout(6_500);
  page.off("request", countPoll);
  assert.ok(polls >= 1, `the visible Notes tab polls for queue movement, saw ${polls}`);
  await row.waitFor();
  assert.match(await row.getByTestId("quick-note-schedule-badge").innerText(), /waits until/i, "the scheduled note still waits after polling");

  const listed = await api<{ notes: Array<{ id: string; title: string; status: string }> }>(node, authSession, "GET", `/projects/${projectId}/quick-notes`);
  const held = listed.body.notes.find((note) => note.title === "Hold for the morning");
  assert.ok(held, "the scheduled note is still listed");
  assert.equal(held.status, "pending", "a future note is not started by the queue");
  await fetch(`${node.url}/api/quick-notes/${held.id}`, { method: "DELETE", headers: { Cookie: authSession.cookie, "x-csrf-token": authSession.csrfToken } });
  const disabled = await api<{ queue: { enabled: boolean; maxParallel: number } }>(node, authSession, "PUT", "/quick-notes/queue", { queue: { enabled: false, maxParallel: 1 } });
  assert.equal(disabled.body.queue.enabled, false, "the queue is left off for the tests after it");
});
