// A conversation the node refuses to open (deleted, locked, signed out) closes its socket
// with code 1008 and a reason. The page used to treat that like a dropped connection: it
// showed "Connecting…" and asked again every 1.5 s for as long as it stayed open, so the
// reason never reached the reader and the node kept searching for the conversation.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Page, WebSocketRoute } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

const PROJECT_NAME = "Internal Assistant";
const CONVERSATION_TITLE = "Makor deployment information";

/** Signs in with every conversation socket passing through `onConversation`; the list's watch socket is left alone. */
async function openProject(t: TestContext, onConversation: (socket: WebSocketRoute) => void, beforeLoad?: (page: Page) => Promise<void>): Promise<Page> {
  const { page, environment, node } = await nativeUiFixture(t);
  await beforeLoad?.(page);
  await page.routeWebSocket(/\/ws\?/, (socket) => {
    if (socket.url().includes("sessionPath=watch")) socket.connectToServer();
    else onConversation(socket);
  });
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: PROJECT_NAME }).first().click();
  await page.locator(".session-card", { hasText: CONVERSATION_TITLE }).first().waitFor();
  return page;
}

const composerEnabled = (page: Page) => page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);

test("a refused conversation shows the node's reason, retries slowly, and opens once the refusal clears", { timeout: 120_000 }, async (t) => {
  let refusing = true;
  const attempts: number[] = [];
  const page = await openProject(t, (socket) => {
    attempts.push(Date.now());
    if (refusing) socket.close({ code: 1008, reason: "Project is locked by Homeserver" });
    else socket.connectToServer();
  });
  await page.locator(".session-card", { hasText: CONVERSATION_TITLE }).first().click();

  const placeholder = page.locator("#messages .empty-state");
  await placeholder.getByRole("heading", { name: "Can't open this conversation" }).waitFor();
  assert.match(await placeholder.innerText(), /Project is locked by Homeserver\. Trying again…/);
  assert.match(await page.getByTestId("chat-reconnect-banner").innerText(), /Project is locked by Homeserver/);

  // Retries after 1.5 s, 3 s and 6 s: three attempts in the first eight seconds, where
  // the fixed 1.5 s loop made six.
  await page.waitForTimeout(8_000);
  assert.ok(attempts.length >= 2, "a refusal that can clear is still retried");
  assert.ok(attempts.length <= 4, `a refused conversation was asked for ${attempts.length} times in 8 s`);
  assert.equal(await placeholder.count(), 1, "retries keep one message instead of stacking them");

  refusing = false;
  await composerEnabled(page);
  assert.equal(await placeholder.count(), 0, "the transcript replaces the refusal once the node opens the conversation");
  assert.equal(await page.getByTestId("chat-reconnect-banner").isHidden(), true);
});

// The list is on screen before the page knows which agents exist. Opening a conversation in
// that window threw: from a list row before anything changed, and from the board after the
// placeholder was drawn, which left "Connecting…" on screen with no socket behind it.
for (const [origin, open] of [
  ["a list row", (page: Page) => page.locator(".session-card", { hasText: CONVERSATION_TITLE }).first().click()],
  ["the board", (page: Page) => page.evaluate(async (title) => {
    const { state } = await import("/app/state.js");
    const { openSession } = await import("/app/socket.js");
    const session = state.sessions.find((candidate: { title: string }) => candidate.title.includes(title));
    openSession(session.path, session.title);
  }, CONVERSATION_TITLE)],
] as const) {
  test(`a conversation opened from ${origin} before the agent list has loaded still opens`, { timeout: 120_000 }, async (t) => {
    let releaseAgents = (): void => undefined;
    const agentsHeld = new Promise<void>((resolve) => { releaseAgents = resolve; });
    const page = await openProject(t, (socket) => socket.connectToServer(), async (page) => {
      await page.route("**/api/harnesses", async (route) => {
        await agentsHeld;
        await route.continue().catch(() => undefined);
      });
    });
    await open(page);
    await page.waitForTimeout(1_000);
    releaseAgents();
    await composerEnabled(page);
  });
}

/** Answers the conversation list without the conversation under test, as a node that no longer lists it would. */
async function hideFromList(page: Page): Promise<void> {
  await page.route("**/api/projects/*/sessions", async (route) => {
    // The page keeps polling the list; a request still in flight when the browser closes is not a failure.
    const response = await route.fetch().catch(() => null);
    if (!response) return;
    const body = await response.json() as { sessions: Array<{ title: string }> };
    await route.fulfill({ response, json: { ...body, sessions: body.sessions.filter((session) => !session.title.includes(CONVERSATION_TITLE)) } }).catch(() => undefined);
  });
}

test("a conversation the local node no longer has is left, not retried", { timeout: 120_000 }, async (t) => {
  let live: WebSocketRoute | undefined;
  let deleted = false;
  const page = await openProject(t, (socket) => {
    if (deleted) { socket.close({ code: 1008, reason: "Conversation not found" }); return; }
    live = socket;
    socket.connectToServer();
  });
  await page.locator(".session-card", { hasText: CONVERSATION_TITLE }).first().click();
  await composerEnabled(page);

  await hideFromList(page);
  deleted = true;
  await live!.close({ code: 1012 });
  await page.locator("#sessionTitle", { hasText: "Select a conversation" }).waitFor();
  assert.equal(await page.getByTestId("chat-reconnect-banner").isHidden(), true);
});

// A conversation that has only run the automatic start command is hidden from the list.
// Leaving it whenever its socket was down during a list refresh threw a phone out of every
// new conversation it returned to, with no row left to open it again.
test("a dropped socket does not leave a conversation that is missing from the list", { timeout: 120_000 }, async (t) => {
  let live: WebSocketRoute | undefined;
  const page = await openProject(t, (socket) => {
    live = socket;
    socket.connectToServer();
  });
  await page.locator(".session-card", { hasText: CONVERSATION_TITLE }).first().click();
  await composerEnabled(page);

  await hideFromList(page);
  await live!.close({ code: 1012 });
  await page.evaluate(`(async () => {
    const { refreshSessionsQuietly } = await import("/app/socket.js");
    await refreshSessionsQuietly();
  })()`);
  assert.equal(await page.locator(".session-card", { hasText: CONVERSATION_TITLE }).count(), 0, "the list no longer shows the conversation");
  assert.equal((await page.locator("#sessionTitle").innerText()).includes("Select a conversation"), false, "the conversation stays open while its socket reconnects");
  await composerEnabled(page);
});
