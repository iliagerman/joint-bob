import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";
import { launchChrome } from "./launch-chrome.js";

/** Lists fit their space and page: none of them may scroll vertically. */
async function assertListsFit(page: Page, label: string): Promise<void> {
  const overflowing = await page.locator(".res-list").evaluateAll(lists => lists.filter(list => list.scrollHeight > list.clientHeight + 1).length);
  assert.equal(overflowing, 0, `${label}: a list scrolls instead of paging`);
}

test("assistant shell: resources, public actions, activity and discovery without a relay", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assistant-social-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card").first().waitFor();
    const projectId = node.projects[0].id;
    const assistantId = await page.evaluate(async (project) => {
      const { csrfToken } = await (await fetch("/api/auth/status")).json();
      const { sessions } = await (await fetch(`/api/projects/${project}/sessions`)).json();
      const response = await fetch("/api/personal-assistants", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ projectId: project, engine: sessions[0].harnessId, sessionId: sessions[0].id, name: "Work assistant", instructions: "" }) });
      return (await response.json()).assistant.id as string;
    }, projectId);

    // The desktop workspace switches to assistants with its own button, and back.
    await page.getByTestId("projects-open-assistants-button").click();
    await page.locator("#rail-assistants").getByText("Work assistant").waitFor();
    await page.locator(".brand-workspace").click();
    await page.locator(".project-card").first().waitFor();

    // Desktop shell: rail with the assistant, tabs, and Resources.
    await page.goto(`${node.url}/assistant.html?id=${assistantId}&view=resources`);
    await page.locator("#heading").getByText("Work assistant").waitFor();
    assert.equal(await page.locator("#rail").isVisible(), true, "desktop shows the rail");
    assert.equal(await page.locator("#tabbar").isVisible(), false, "desktop has no bottom tabs");
    await page.getByTestId("assistant-resources-section-browser").waitFor();
    assert.equal(await page.locator(".side-item").count(), 8, "eight resource sections");
    await page.getByText("No logins yet. Add one and sign in yourself. Every topic can use it.").waitFor();
    await page.getByTestId("assistant-add-login").click();
    await page.locator("#add-login").waitFor();
    await page.getByRole("button", { name: "Saved login" }).click();
    await page.getByText("No saved logins to attach.").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#overlay").waitFor({ state: "hidden" });

    // Files: the assistant's folder, kept across all its topics.
    await page.getByTestId("assistant-resources-section-files").click();
    await page.getByText("No files yet.", { exact: false }).waitFor();
    await page.getByTestId("assistant-file-input").setInputFiles({ name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("Rome in May") });
    const fileRow = page.getByTestId("assistant-resources-files").locator(".res-row", { hasText: "plan.txt" });
    await fileRow.waitFor();
    assert.equal(await fileRow.getByRole("link", { name: "Download" }).getAttribute("href"), `/api/personal-assistants/${assistantId}/files/download?path=plan.txt`);
    await fileRow.getByRole("button", { name: "Delete" }).click();
    await page.getByTestId("assistant-resource-delete-confirm").click();
    await page.getByText("No files yet.", { exact: false }).waitFor();

    // Memory: notes the owner can read and edit, and turn off.
    await page.getByTestId("assistant-resources-section-memory").click();
    await page.getByTestId("assistant-memory-text").fill("I prefer trains.");
    await page.getByTestId("assistant-memory-save").click();
    await page.locator("#message", { hasText: "Memory saved." }).waitFor();
    await page.getByTestId("assistant-resources-section-browser").click();
    await page.getByTestId("assistant-resources-section-memory").click();
    assert.equal(await page.getByTestId("assistant-memory-text").inputValue(), "I prefer trains.");
    await page.getByTestId("assistant-memory-switch").click();
    await page.getByText("Memory is off. Its notes stay saved.").first().waitFor();
    await page.getByTestId("assistant-memory-switch").click();
    await page.getByText("Keeps notes between topics").waitFor();

    // Telegram: connect a bot, link your account, and approve who can use it.
    const telegramApi = `**/api/personal-assistants/${assistantId}/telegram`;
    const noVoice = { replies: true, transcription: null, speech: null, local: { allowed: true, installed: false, outdated: false, installing: false, installError: null, reason: null }, elevenLabsConflict: false };
    const connectedBot = { connected: true, botUsername: "family_bot", readsAllGroupMessages: false, voice: noVoice, owner: null, waiting: [{ kind: "user", id: "999", name: "Stranger", state: "pending" }, { kind: "chat", id: "-5", name: "Family", state: "pending" }], allowed: [], blocked: [], calls: [{ status: "refused", detail: "Refused Stranger: not approved", at: "2026-11-03T07:00:00.000Z" }] };
    await page.route(telegramApi, route => route.request().method() === "POST"
      ? route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ...connectedBot, pairingLink: "https://t.me/family_bot?start=code" }) })
      : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: false, bases: [{ id: "direct", label: "This machine's own address" }] }) }));
    const accessCalls: unknown[] = [];
    await page.route(`${telegramApi}/access`, route => {
      accessCalls.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...connectedBot, owner: { id: "111", name: "Ilia" }, waiting: connectedBot.waiting.slice(1), allowed: [connectedBot.waiting[0]] }) });
    });
    await page.goto(`${node.url}/assistant.html?id=${assistantId}&view=resources`);
    await page.getByTestId("assistant-resources-section-telegram").click();
    const connectForm = page.getByTestId("assistant-telegram-connect");
    await connectForm.waitFor();
    assert.equal(await page.getByTestId("assistant-telegram-token").getAttribute("type"), "password", "the token isn't shown while typing");
    await page.getByTestId("assistant-telegram-token").fill("123456:AAtestTOKENtestTOKENtestTOKEN");
    await connectForm.getByRole("button", { name: "Connect" }).click();
    await page.getByTestId("assistant-telegram-link").getByRole("link", { name: "Open this link in Telegram" }).waitFor();
    assert.equal(await page.getByTestId("assistant-telegram-link").getByRole("link").getAttribute("href"), "https://t.me/family_bot?start=code");
    await page.getByTestId("assistant-telegram-privacy").waitFor();
    // Voice: on by default, and nothing is downloaded until someone asks.
    await page.getByTestId("assistant-telegram-voice").getByText("the agent gets the audio file and answers in text", { exact: false }).waitFor();
    const voiceCalls: Array<{ url: string; body: unknown }> = [];
    await page.route(`${telegramApi}/voice-replies`, route => {
      voiceCalls.push({ url: "voice-replies", body: route.request().postDataJSON() });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...connectedBot, voice: { ...noVoice, replies: false } }) });
    });
    await page.route(`${telegramApi}/voice/install`, route => {
      voiceCalls.push({ url: "install", body: route.request().postDataJSON() });
      return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ...connectedBot, voice: { ...noVoice, local: { ...noVoice.local, installed: true }, transcription: "local", speech: "kokoro" } }) });
    });
    const voiceSwitch = page.getByTestId("assistant-telegram-voice-replies");
    assert.equal(await voiceSwitch.getAttribute("aria-checked"), "true");
    await voiceSwitch.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="assistant-telegram-voice-replies"]')?.getAttribute("aria-checked") === "false");
    await page.getByTestId("assistant-telegram-voice-install").click();
    await page.getByTestId("assistant-telegram-voice").getByText("transcribed on this machine", { exact: false }).waitFor();
    assert.deepEqual(voiceCalls, [{ url: "voice-replies", body: { enabled: false } }, { url: "install", body: {} }]);
    assert.equal(await page.getByTestId("assistant-telegram-voice-install").count(), 0);
    await page.getByText("Everyone in an approved group can use", { exact: false }).waitFor();
    const waitingRow = page.locator(".res-row", { hasText: "Stranger" });
    await waitingRow.getByRole("button", { name: "Approve" }).click();
    await page.getByTestId("assistant-telegram-owner").getByText("Linked to Ilia (111)").waitFor();
    assert.deepEqual(accessCalls, [{ kind: "user", id: "999", state: "approved" }]);
    assert.equal(await page.getByTestId("assistant-telegram-link").count(), 0, "the link goes away once an account is linked");
    const allowedRow = page.locator(".res-row", { hasText: "Stranger" });
    await allowedRow.getByRole("button", { name: "Remove" }).waitFor();
    assert.ok((await allowedRow.boundingBox())!.height >= 40, "the rows keep their height in the scrolling panel");
    await page.unroute(telegramApi);
    await page.unroute(`${telegramApi}/access`);
    await page.unroute(`${telegramApi}/voice-replies`);
    await page.unroute(`${telegramApi}/voice/install`);

    await page.goto(`${node.url}/assistant.html?id=${assistantId}&view=resources`);
    await page.getByTestId("assistant-resources-section-skills").click();
    await page.getByTestId("assistant-resources-skills").waitFor();
    await page.getByTestId("assistant-add-skill").click();
    await page.getByRole("button", { name: "Choose a folder with SKILL.md" }).waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#overlay").waitFor({ state: "hidden" });
    await assertListsFit(page, "desktop skills");
    const skillSwitch = page.getByTestId("assistant-resources-skills").locator(".switch").first();
    if (await skillSwitch.count()) {
      const saved = page.waitForResponse(response => response.url().endsWith(`/api/personal-assistants/${assistantId}/resources`) && response.request().method() === "PUT");
      await skillSwitch.click();
      assert.equal((await saved).status(), 200, "turning a skill off saves the assistant's choice");
      assert.equal(await page.getByTestId("assistant-resources-skills").locator(".switch").first().getAttribute("aria-checked"), "false");
    }
    await page.getByTestId("assistant-resources-section-secrets").click();
    await page.getByTestId("assistant-resources-secrets").waitFor();
    await assertListsFit(page, "desktop secrets");

    // Public actions: drafts need an operation, then publish and disable.
    await page.getByTestId("assistant-view-actions").click();
    await page.getByText("No public actions yet.", { exact: false }).waitFor();
    await page.getByTestId("assistant-new-action").click();
    await page.locator("#action-form").waitFor();
    await page.locator("#action-form [name=name]").fill("Share my travel plan");
    await page.locator("#action-form [name=description]").fill("Tells people when I'm away.");
    await page.getByTestId("assistant-publish-action").click();
    await page.locator("#message", { hasText: "Choose what this action is allowed to do" }).waitFor();
    await page.locator("#action-form input[value='info.share']").check();
    await page.locator("#action-form [name=shareText]").fill("Away 10–14 Nov.");
    await page.getByTestId("assistant-publish-action").click();
    await page.locator("#actions-view .card-top .chip", { hasText: "Published" }).waitFor();
    await page.getByTestId("assistant-action-test").locator("button[type=submit]").click();
    await page.getByTestId("assistant-action-test-result").waitFor();
    assert.match(await page.getByTestId("assistant-action-test-result").textContent() || "", /No decision|Do it|Ask you first|Decline/, "a test shows the decision model's answer, or that it gave none");
    await page.getByRole("button", { name: "Disable", exact: true }).click();
    await page.locator("#actions-view .card-top .chip", { hasText: "Disabled" }).waitFor();

    // A sent message stays in the chat with a running "Working on it…" until its answer arrives.
    await page.getByTestId("assistant-view-chat").click();
    await page.locator("#chat-form").waitFor();
    let releaseTurn!: () => void;
    const turnHeld = new Promise<void>(resolve => { releaseTurn = resolve; });
    await page.route("**/api/personal-assistants/*/turn", async route => {
      await turnHeld;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ turn: { status: "completed" } }) });
    });
    const send = page.locator("#chat-form button[type=submit]");
    const chatBox = page.locator("#chat-message");
    await chatBox.fill("Plan my week");
    await send.click();
    const working = page.getByTestId("assistant-working");
    await working.waitFor();
    assert.equal(await chatBox.inputValue(), "", "the box empties as soon as the message is sent");
    assert.equal(await page.locator("#timeline .chat-bubble.user.pending", { hasText: "Plan my week" }).count(), 1, "the sent message shows at once");
    await page.waitForTimeout(6_000); // longer than a passing status line lasts
    assert.equal(await working.isVisible(), true, "the status stays while the answer is pending");
    assert.match(await working.textContent() || "", /^Working on it… \d+:\d\d$/);
    assert.equal(await send.isDisabled(), true);
    await chatBox.fill("Draft typed while waiting");
    await chatBox.press("Control+Enter");
    assert.equal(await page.locator("#timeline .chat-bubble.user.pending").count(), 1, "the keyboard shortcut can't send a second turn while one is running");
    assert.equal(await chatBox.inputValue(), "Draft typed while waiting");
    releaseTurn();
    await working.waitFor({ state: "detached" });
    assert.equal(await send.isDisabled(), false, "send is available again once the answer is in");
    assert.equal(await chatBox.inputValue(), "Draft typed while waiting", "the answer doesn't wipe a draft typed meanwhile");
    // A failed send puts the message back, and retrying it is the same turn.
    const sentRequestIds: string[] = [];
    await page.route("**/api/personal-assistants/*/turn", async route => {
      sentRequestIds.push(route.request().postDataJSON().requestId);
      if (sentRequestIds.length === 1) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Turn failed" }) });
      else await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ turn: { status: "completed" } }) });
    });
    await chatBox.fill("Retry me");
    await send.click();
    await page.locator("#message", { hasText: "Turn failed" }).waitFor();
    assert.equal(await chatBox.inputValue(), "Retry me", "a failed message returns to the box");
    await send.click();
    await working.waitFor({ state: "detached" });
    assert.equal(sentRequestIds.length, 2);
    assert.equal(sentRequestIds[0], sentRequestIds[1], "retrying can't create a second turn");
    assert.equal(await chatBox.inputValue(), "", "a successful retry leaves the box empty");
    await page.unroute("**/api/personal-assistants/*/turn");

    // Answers are formatted; what the person typed stays exactly as typed.
    await page.route("**/api/personal-assistants/*/transcript", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ timeline: [
        { id: "question", role: "user", text: "Give me **my** report", createdAt: "2026-11-03T07:00:00.000Z" },
        { id: "hook", role: "user", text: '[Joint Bob webhook: Telegram]\n\nSender: Ilia (111). This sender is on the list.\n\nPayload:\n```\n{"message":{"text":"Plan my week"}}\n```', createdAt: "2026-11-03T07:00:00.500Z" },
        { id: "answer", role: "assistant", text: "## Morning report\n\n- **Urgent:** call Noa\n- See [the plan](https://example.com/plan)\n\n<img src=x onerror=alert(1)>", createdAt: "2026-11-03T07:00:01.000Z" },
      ] }),
    }));
    await page.getByTestId("assistant-view-settings").click();
    await page.getByTestId("assistant-view-chat").click();
    const answer = page.locator("#timeline .chat-bubble.assistant");
    await answer.locator("h2", { hasText: "Morning report" }).waitFor();
    assert.equal(await answer.locator("li strong").textContent(), "Urgent:");
    assert.equal(await answer.locator("a").getAttribute("href"), "https://example.com/plan");
    assert.equal((await answer.textContent() || "").includes("**"), false, "no raw Markdown markers remain");
    assert.equal(await answer.locator("img").count(), 0, "HTML in an answer is shown as text, never parsed");
    assert.equal(await answer.evaluate(element => getComputedStyle(element).whiteSpace), "normal");
    assert.equal(await answer.locator("ul").evaluate(element => getComputedStyle(element).listStyleType), "disc");
    assert.equal(await page.locator("#timeline .chat-bubble.user").first().textContent(), "Give me **my** report");
    const webhookBubble = page.locator("#timeline details.chat-bubble.webhook");
    assert.equal(await webhookBubble.locator("summary").innerText(), "From Telegram · Ilia (111)\nPlan my week", "a webhook's message stays folded behind who sent it");
    assert.equal(await webhookBubble.locator("pre").isVisible(), false);
    await page.unroute("**/api/personal-assistants/*/transcript");

    // Someone else's assistant answers a direct request the same way.
    const threadPath = "**/api/social/threads/formatted-thread";
    await page.route(threadPath, route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        online: true,
        catalog: [],
        assistant: { name: "Calendar helper", ownerName: "Maya Shalev" },
        messages: [
          { id: "ask", author: "requester", text: "Is **Tuesday** free?", state: "recorded" },
          { id: "reply", author: "assistant", text: "**Yes**, Tuesday is free." },
        ],
      }),
    }));
    const assistantUrl = page.url();
    await page.goto(new URL("/assistant.html?thread=formatted-thread", assistantUrl).href);
    const threadMessages = page.getByTestId("assistant-thread-messages");
    assert.equal(await threadMessages.locator(".m.bot-msg .bubble strong").textContent(), "Yes");
    assert.equal(await threadMessages.locator(".m.me .bubble").textContent(), "Is **Tuesday** free?");
    await page.unroute(threadPath);
    await page.goto(assistantUrl);
    await page.locator("#chat-form").waitFor();

    // Activity: empty, private, and closing returns to the same chat.
    await page.getByTestId("assistant-activity-button").click();
    await page.getByTestId("assistant-activity").getByText("Nothing yet.", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Close activity and return to chat" }).click();
    await page.locator("#overlay").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#chat-form").isVisible(), true);

    // On a machine with a relay, one switch hides the assistant; while it's on, relays can be chosen.
    const relay = { relayNodeId: "11111111-1111-4111-8111-111111111111", name: "Team", active: true };
    let listed = true;
    const puts: unknown[] = [];
    await page.route("**/api/social/me", async route => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, body: JSON.stringify({ ...body, relays: [relay], discovery: listed ? [{ subjectKind: "assistant", subjectId: assistantId, relayNodeId: relay.relayNodeId }] : [] }) });
    });
    await page.route("**/api/social/findable", async route => {
      puts.push(route.request().postDataJSON());
      listed = !listed;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ discovery: listed ? [{ subjectKind: "assistant", subjectId: assistantId, relayNodeId: relay.relayNodeId }] : [] }) });
    });
    await page.goto(`${node.url}/assistant.html?id=${assistantId}&view=settings`);
    const findableSwitch = page.getByTestId("assistant-findable-switch");
    assert.equal(await findableSwitch.getAttribute("aria-checked"), "true");
    await page.getByRole("switch", { name: "Work assistant findable on Team" }).waitFor();
    assert.equal((await page.locator("#settings-discovery").textContent())?.includes("[object"), false, "the relay rows are elements, not text");
    await findableSwitch.click();
    await page.getByText("Hidden from everyone").waitFor();
    assert.deepEqual(puts, [{ subjectKind: "assistant", subjectId: assistantId, findable: false }]);
    assert.equal(await page.getByRole("switch", { name: "Work assistant findable on Team" }).count(), 0, "a hidden assistant has no relays to choose");
    listed = true;
    await page.goto(`${node.url}/assistant.html?screen=you`);
    assert.equal(await page.getByTestId("assistant-findable-all-assistant").getAttribute("aria-checked"), "true");
    await page.unroute("**/api/social/me");
    await page.unroute("**/api/social/findable");
    await page.goto(`${node.url}/assistant.html?id=${assistantId}`);
    await page.locator("#chat-form").waitFor();

    // Who can find you and Find, with no relay on this machine.
    await page.locator("#rail-you").click();
    await page.getByText("This machine isn't on a relay yet.", { exact: false }).waitFor();
    await page.getByRole("radio", { name: "Work assistant" }).click();
    await page.locator("#message", { hasText: "Work assistant is your default" }).waitFor();
    await page.getByRole("radio", { name: "Work assistant", checked: true }).waitFor();
    await page.locator(".rail-search").click();
    await page.getByText("This machine isn't on a relay yet.", { exact: false }).waitFor();
    await page.locator("#rail-groups").getByText("Invitations").click();
    await page.getByText("No invitations yet.").waitFor();

    // Phone: bottom tabs on lists, full-screen details, Resources pages instead of scrolling.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${node.url}/assistant.html`);
    await page.locator("#chooser").waitFor({ state: "visible" });
    assert.equal(await page.locator("#tabbar").isVisible(), true, "lists show the bottom tabs");
    assert.equal(await page.locator("#rail").isVisible(), false);
    await page.locator("#tabbar [data-tab=groups]").click();
    await page.locator("#social-view").getByText("Invitations").waitFor();
    await page.locator("#tabbar [data-tab=assistants]").click();
    await page.getByRole("button", { name: "Work assistant", exact: true }).click();
    await page.locator("#chat-form").waitFor({ state: "visible" });
    assert.equal(await page.locator("#tabbar").isVisible(), false, "a detail screen hides the bottom tabs");
    await page.getByTestId("assistant-view-resources").click();
    await page.getByTestId("assistant-resources-section-skills").click();
    await page.getByText("Back to resources").waitFor();
    await assertListsFit(page, "phone skills");
    const tabsFit = await page.locator("#assistant-nav").evaluate(tabs => tabs.scrollWidth <= tabs.clientWidth + 1);
    assert.equal(tabsFit, true, "assistant tabs fit a phone width");
    await page.getByText("Back to resources").click();
    assert.equal(await page.locator(".side-item").count(), 8);
    assert.deepEqual(errors, [], "the page runs without script errors");
  } finally {
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
