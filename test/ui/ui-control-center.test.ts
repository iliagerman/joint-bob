import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

const BOARD = {
  projects: [{ id: "p1", name: "Joint Bob" }, { id: "p2", name: "DAK Live" }],
  cards: [
    { projectId: "p1", projectName: "Joint Bob", conversationId: "c1", sessionId: "c1", path: "/c1", title: "Mobile menu", column: "running", agentId: "claude", agentLabel: "Claude", agentModel: "sonnet", executionNodeId: null, updatedAt: "2026-11-05T10:00:00Z", turnRunning: true, backgroundRunning: false, summary: "Running the UI tests", activity: "Bash · npm run test:ui -- test/ui/menu.test.ts", autoRespondActive: true },
    { projectId: "p2", projectName: "DAK Live", conversationId: "c2", sessionId: "c2", path: "/c2", title: "Slice 7: stop follow-up nudges while an agent owes the customer an answer, then map it", column: "running", agentId: "pi", agentLabel: "Pi", agentModel: null, executionNodeId: null, updatedAt: "2026-11-05T09:00:00Z", turnRunning: true, backgroundRunning: false, summary: null, autoRespondActive: false, startedBy: "bob" },
    { projectId: "p1", projectName: "Joint Bob", conversationId: "c3", sessionId: "c3", path: "/c3", title: "Review counter", column: "review", agentId: "claude", agentLabel: "Claude", agentModel: null, executionNodeId: null, updatedAt: "2026-11-05T08:00:00Z", turnRunning: false, backgroundRunning: false, summary: "**Goal** — Fix the review counter.\n**Done so far** — The counter counts reviews again.\n**Current state** — Fixed and tested; it waits for your review. The tests ran twice.", autoRespondActive: false, reviewCheck: { verdict: "done", reason: "", by: "Decision model 94%", pushes: 0, pushPending: false, needsYou: false } },
  ],
};

test("the control center shows the live board, filters by project, colors cards and resets", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  // Boot resets the view to the project list as its last step; open the control center only after that.
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    window.__timeline = [{ id: 'old', role: 'system', text: 'Prod 5xx at 14%', via: null, projectId: 'p1', projectName: 'Joint Bob', importance: 'urgent', actions: [], createdAt: new Date().toISOString() },
      { id: 'rep', role: 'bob', text: 'Morning report', via: null, projectId: null, projectName: null, importance: 'report', actions: [], createdAt: new Date().toISOString() }];
    window.fetch = async (...args) => {
      const path = new URL(String(args[0]), location.href).pathname;
      if (path === '/api/control-center/bob/message') {
        const body = JSON.parse(args[1].body);
        window.__bobRequests = [...(window.__bobRequests || []), body];
        const started = body.message.startsWith('fix');
        if (body.message.startsWith('make it')) {
          const user = { id: 'm' + window.__timeline.length, role: 'user', text: body.message, via: null, importance: 'fyi', actions: [], createdAt: new Date().toISOString(), projectId: null, projectName: null };
          const reply = { id: 'm' + (window.__timeline.length + 1), role: 'bob', text: 'Switched to Midnight and made everything larger.', via: 'Display agent · haiku · TypeSafe (Jev) chose level 1', importance: 'done', projectId: null, projectName: null, createdAt: new Date().toISOString(),
            actions: [{ id: 'display.undo', label: 'Undo', data: { appearance: body.appearance.settings } }] };
          window.__timeline.push(user, reply);
          return new Response(JSON.stringify({ action: 'answer', user, reply, projectId: null, appearance: { ...body.appearance.settings, theme: 'midnight', global: 1.15 } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const project = body.projectId === 'p2' ? { projectId: 'p2', projectName: 'DAK Live' } : started ? { projectId: 'p1', projectName: 'Joint Bob' } : { projectId: null, projectName: null };
        const make = (role, text, extra = {}) => ({ id: 'm' + window.__timeline.length, role, text, via: null, importance: 'fyi', actions: [], createdAt: new Date().toISOString(), ...project, ...extra });
        const user = make('user', body.message);
        window.__timeline.push(user);
        if (body.message.startsWith('slow')) {
          // As the server does: the message is saved and the page told at once; the answer comes when the test lets it.
          window.dispatchEvent(new CustomEvent('control-center-changed'));
          await new Promise((resolve) => { window.__release = resolve; });
          const answer = make('bob', 'Here is your report.');
          window.__timeline.push(answer);
          return new Response(JSON.stringify({ action: 'answer', user, reply: answer, projectId: null }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const reply = started
          ? make('bob', 'Started in ' + project.projectName + '. It is on the board now.', { via: 'Decision model 93% · task' })
          : make('bob', '**Two conversations are running.**\\n- Mobile menu\\n- Slice 7', { via: "Decision model 60% is under the threshold, so Bob's agent decided" });
        window.__timeline.push(reply);
        return new Response(JSON.stringify({ action: started ? 'started' : 'answer', user, reply, projectId: project.projectId }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === '/api/control-center/bob/messages') {
        const query = new URL(String(args[0]), location.href).searchParams;
        const levels = { important: ['needs-ok', 'urgent', 'needs-you'], reports: ['report', 'done'], fyi: ['fyi'] }[query.get('importance')];
        const wanted = window.__timeline.filter((message) => (!levels || levels.includes(message.importance))
          && (!query.get('project') || (query.get('project') === 'general' ? !message.projectId : message.projectId === query.get('project'))));
        return new Response(JSON.stringify({ messages: wanted, waiting: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path !== '/api/control-center/board') return originalFetch(...args);
      return new Response(JSON.stringify(${JSON.stringify(BOARD)}), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  })()`);

  await page.getByTestId("projects-open-control-center-button").click();
  await page.waitForSelector('[data-testid="control-center-card"]');
  assert.equal(await page.locator("body.view-control").count(), 1);
  assert.equal(await page.getByTestId("control-center-card").count(), 3);
  assert.match(await page.getByTestId("control-center-count").textContent() ?? "", /^2 running/);
  assert.match(await page.locator('[data-key="p1:c1"]').textContent() ?? "", /Running the UI tests/);
  assert.match(await page.locator('[data-key="p1:c1"]').textContent() ?? "", /System drives/, "auto respond drives it");
  assert.match(await page.locator('[data-key="p2:c2"]').textContent() ?? "", /Working…/);
  assert.equal(await page.locator('[data-key="p1:c3"]').getAttribute("data-column"), "review");
  // A card says briefly where the conversation stands: the first sentence of the summary's current state, without Markdown.
  const review = page.locator('[data-key="p1:c3"]');
  assert.equal(await review.locator(".control-live-text").textContent(), "Fixed and tested; it waits for your review.");
  assert.match(await review.locator(".control-live").getAttribute("title") ?? "", /^Goal — Fix the review counter\. Done so far/, "the whole summary is on hover");
  assert.match(await review.textContent() ?? "", /To review/, "finished work waiting for the person is marked");
  assert.equal(await review.getByTestId("control-card-check").textContent(), "✓ Bob checked: done", "Bob checked that it is really done");
  assert.equal(await page.locator('.control-lane[data-column="review"] .control-lane-count').textContent(), "1");
  // Every card is the same size, whatever its title, status, ribbon or check line; a long title is cut, and whole on hover.
  const heights = await page.getByTestId("control-center-card").evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height));
  assert.equal(new Set(heights).size, 1, `card heights: ${heights.join(", ")}`);
  assert.match(await page.locator('[data-key="p2:c2"] .control-title').getAttribute("title") ?? "", /then map it$/);
  // A running card says what the turn is doing now, over the summary's line; a finished one has a Review button instead of Take control.
  assert.equal(await page.locator('[data-key="p1:c1"]').getByTestId("control-card-activity").textContent(), "Bash · npm run test:ui -- test/ui/menu.test.ts");
  assert.equal(await page.locator('[data-key="p1:c1"] .control-live-text').textContent(), "Running the UI tests");
  assert.match(await page.locator('[data-key="p1:c1"] .control-live').getAttribute("title") ?? "", /Now: Bash · npm run test:ui/);
  assert.equal(await page.locator('[data-key="p2:c2"]').getByTestId("control-card-activity").count(), 0, "no activity known, so the summary line stays");
  assert.equal(await review.getByTestId("control-card-action-review").isVisible(), true);
  assert.equal(await review.getByTestId("control-card-action-take-control").count(), 0);
  assert.equal(await page.locator('[data-key="p1:c1"]').getByTestId("control-card-action-review").count(), 0, "only finished work is reviewed");

  // Filter to one project.
  await page.getByTestId("control-center-filters").getByText("DAK Live").click();
  assert.equal(await page.getByTestId("control-center-card").count(), 1);
  await page.getByTestId("control-center-filters").getByText("All", { exact: true }).click();
  assert.equal(await page.getByTestId("control-center-card").count(), 3);

  // The whole card takes the picked color.
  await page.locator('[data-key="p1:c1"] [data-testid="control-center-color"]').evaluate((input: HTMLInputElement) => {
    input.value = "#ff6b9a";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await page.locator('[data-key="p1:c1"]').evaluate((card) => card.style.getPropertyValue("--card-color")), "#ff6b9a");
  assert.equal(await page.locator('[data-key="p1:c1"]').evaluate((card) => card.classList.contains("colored")), true);

  // One layout: each lane groups its conversations by project, projects in name order. Reset clears colors and the filter.
  assert.equal(await page.getByTestId("control-center-layout-free").count(), 0, "there is no free layout");
  const running = page.locator('.control-lane[data-column="running"] + .control-lane-groups [data-testid="control-project-group"]');
  assert.deepEqual(await running.locator(".control-project-head b").allTextContents(), ["DAK Live", "Joint Bob"]);
  assert.deepEqual(await page.locator('[data-project="p1"] [data-testid="control-center-card"]').evaluateAll((cards) => cards.map((card) => card.getAttribute("data-key"))), ["p1:c1", "p1:c3"]);
  // Who drives a conversation shows on its card: auto respond is the system, a conversation Bob started is watched by him.
  assert.equal(await page.locator('[data-key="p1:c1"] [data-testid="control-card-driver"]').textContent(), "⚙ System drives");
  assert.equal(await page.locator('[data-key="p2:c2"] [data-testid="control-card-driver"]').textContent(), "👁 Bob watches");
  assert.equal(await page.locator('[data-key="p1:c3"] [data-testid="control-card-driver"]').count(), 0, "the person's own conversation has no driver");
  assert.match(await page.getByTestId("control-center-count").textContent() ?? "", /1 driven by the system · 1 watched by Bob/);
  await page.getByTestId("control-center-reset").click();
  assert.equal(await page.locator('[data-key="p1:c1"]').evaluate((card) => card.classList.contains("colored")), false);

  // Bob's chat keeps its timeline and labels every entry by project and by how much it matters.
  assert.match((await page.getByTestId("control-center-tabs").locator("button").allTextContents())[0], /^Live agents/, "the live board is the first tab");
  const entries = page.getByTestId("control-chat-entry");
  assert.equal(await entries.count(), 2);
  assert.match(await entries.first().innerText(), /Joint Bob[\s\S]*Urgent[\s\S]*Prod 5xx at 14%/);
  assert.match(await entries.nth(1).innerText(), /General[\s\S]*Report[\s\S]*Morning report/);

  await page.getByTestId("control-chat-input").fill("what is running?");
  await page.getByTestId("control-chat-send").click();
  await page.getByTestId("control-chat-messages").getByText("Two conversations are running.").waitFor();
  // Bob's answer is Markdown, shown formatted.
  const answer = page.locator(".control-msg.markdown").last();
  assert.equal(await answer.locator("strong").textContent(), "Two conversations are running.");
  assert.deepEqual(await answer.locator("li").allTextContents(), ["Mobile menu", "Slice 7"]);
  assert.equal((await answer.textContent())?.includes("**"), false);
  assert.match(await page.getByTestId("control-chat-messages").innerText(), /under the threshold, so Bob's agent decided/);
  await page.getByTestId("control-chat-project").selectOption({ label: "DAK Live" });
  await page.getByTestId("control-chat-input").fill("fix the slice 7 map");
  await page.keyboard.press("Enter");
  await page.getByTestId("control-chat-messages").getByText("Started in DAK Live.").waitFor();
  const requests = await page.evaluate("window.__bobRequests") as Array<{ message: string; projectId?: string }>;
  assert.deepEqual(requests.map((request) => request.projectId ?? null), [null, "p2"]);

  // Files can be attached and a screenshot pasted; both go with the message, and the box is cleared once it is sent.
  await page.getByTestId("control-chat-project").selectOption({ label: "Auto" });
  await page.getByTestId("control-chat-files").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("the map is wrong") });
  await page.getByTestId("control-chat-input").evaluate((input) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([new Uint8Array([137, 80, 78, 71])], "screen.png", { type: "image/png" }));
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="control-chat-attachments"] .attachment-chip').length === 2);
  await page.getByTestId("control-chat-input").fill("what is in these?");
  await page.getByTestId("control-chat-send").click();
  await page.waitForFunction(() => (window as unknown as { __bobRequests: unknown[] }).__bobRequests.length === 3);
  const attached = (await page.evaluate("window.__bobRequests") as Array<{ images?: Array<{ name: string; data: string }>; files?: Array<{ name: string; data: string }> }>)[2];
  assert.deepEqual(attached.images?.map((image) => [image.name, image.data]), [["screen.png", "iVBORw=="]]);
  assert.deepEqual(attached.files?.map((file) => [file.name, Buffer.from(file.data, "base64").toString()]), [["notes.txt", "the map is wrong"]]);
  assert.equal(await page.locator('[data-testid="control-chat-attachments"] .attachment-chip').count(), 0);

  // Bob acknowledges a message at once and says how long he has worked on it, until his answer comes; reading the timeline
  // again meanwhile keeps the acknowledgement, and the person's message is shown once.
  await page.getByTestId("control-chat-input").fill("slow: I need my latest report");
  await page.getByTestId("control-chat-send").click();
  const pending = page.getByTestId("control-chat-pending");
  await pending.waitFor();
  assert.match(await pending.innerText(), /^Got it\. Working on “slow: I need my latest report”\s+\d+ s$/);
  await page.getByTestId("control-chat-messages").getByText("slow: I need my latest report", { exact: true }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("control-center-changed")));
  await page.waitForTimeout(1200);
  assert.equal(await pending.isVisible(), true, "the acknowledgement stays while the timeline is read again");
  assert.equal(await page.getByTestId("control-chat-send").isDisabled(), true);
  await page.evaluate("window.__release()");
  await page.getByTestId("control-chat-messages").getByText("Here is your report.").waitFor();
  assert.equal(await pending.count(), 0);
  assert.equal(await page.getByTestId("control-chat-messages").getByText("slow: I need my latest report", { exact: true }).count(), 1, "the message is not shown twice");

  // A display request carries the page's display settings; Bob's display agent's change is applied here, and Undo puts them back.
  const before = await page.evaluate(() => ({ palette: document.documentElement.dataset.palette ?? null, zoom: document.documentElement.style.getPropertyValue("--ui-zoom-chat") }));
  await page.getByTestId("control-chat-input").fill("make it midnight and larger");
  await page.getByTestId("control-chat-send").click();
  await page.waitForFunction(() => document.documentElement.dataset.palette === "midnight");
  const sentDisplay = (await page.evaluate("window.__bobRequests") as Array<{ appearance?: { themes: Array<{ id: string }>; sections: Array<{ id: string }>; settings: { global: number } } }>).at(-1)!.appearance!;
  assert.ok(sentDisplay.themes.some((theme) => theme.id === "midnight") && sentDisplay.sections.some((section) => section.id === "chat"), "the page says what it allows");
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--ui-zoom-chat")), "1.15");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("jointBobAppearance")!).theme), "midnight", "kept like a change made in Settings → Appearance");
  await page.getByTestId("control-chat-messages").getByRole("button", { name: "Undo" }).click();
  await page.waitForFunction((palette) => (document.documentElement.dataset.palette ?? null) === palette, before.palette);
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--ui-zoom-chat")), before.zoom);

  // The filters narrow the timeline by importance and by project.
  await page.getByTestId("control-chat-importance-important").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="control-chat-entry"]').length === 1);
  assert.match(await page.getByTestId("control-chat-entry").innerText(), /Prod 5xx at 14%/);
  await page.getByTestId("control-chat-importance-reports").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="control-chat-entry"]')?.textContent?.includes("Morning report"));
  await page.getByTestId("control-chat-importance-all").click();
  // Choosing a project focuses the whole control center on it: the chat, the board's cards, and where a new message goes.
  await page.getByTestId("control-chat-filter-project").selectOption({ label: "DAK Live" });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="control-chat-entry"]').length === 2);
  assert.deepEqual(await page.getByTestId("control-center-card").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-key"))), ["p2:c2"]);
  assert.equal(await page.getByTestId("control-chat-project").inputValue(), "p2");
  await page.getByTestId("control-center-filters").getByText("All", { exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="control-chat-filter-project"]') as HTMLSelectElement).value === "");
  assert.equal(await page.getByTestId("control-center-card").count(), 3, "the board's own chips focus the chat too");
  await page.getByTestId("control-center-filters").getByText("Joint Bob", { exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('[data-testid="control-chat-filter-project"]') as HTMLSelectElement).value === "p1");
  await page.getByTestId("control-chat-filter-project").selectOption("");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="control-center-card"]').length === 3);

  // Each message says where it comes from and which conversation it is about, and one that waits offers every way forward.
  await page.evaluate(() => {
    const open = { projectId: "p1", conversationId: "c3", title: "Review counter" };
    const conversation = { ...open, projectName: "Joint Bob", engine: "claude", sessionId: "c3" };
    (window as unknown as { __timeline: unknown[] }).__timeline.push({ id: "check", role: "bob", text: '"Review counter" waits for you.\nIt asks which plan to use.', via: "Review check · Decision model 96%", projectId: "p1", projectName: "Joint Bob", importance: "needs-you", createdAt: new Date().toISOString(),
      actions: [{ id: "review.push", label: "Push it on", style: "primary", data: conversation }, { id: "conversation.done", label: "Done", data: conversation }, { id: "conversation.abandon", label: "Abandon", style: "warn", data: conversation }, { id: "open", label: "Open", data: { open } }] });
    window.dispatchEvent(new CustomEvent("control-center-changed"));
  });
  const check = page.getByTestId("control-chat-entry").filter({ hasText: "It asks which plan to use" });
  await check.waitFor();
  // A message about a conversation is a card: its project and the conversation's name on top, then who raised it, then what it says.
  assert.equal(await check.locator(".control-entry-project").textContent(), "Joint Bob");
  assert.equal(await check.getByTestId("control-chat-about").textContent(), "Review counter");
  assert.match(await check.locator(".control-entry-event").innerText(), /^Needs you\s+Bob checked it when it stopped\s+\S/);
  assert.equal(await check.locator(".control-msg").innerText(), "Waits for you.\nIt asks which plan to use.", "the name is not repeated");
  assert.notEqual(await check.evaluate((card) => getComputedStyle(card).borderLeftColor), await page.getByTestId("control-chat-entry").filter({ hasText: "Morning report" }).evaluate((entry) => getComputedStyle(entry).borderLeftColor), "drawn in its project's color");
  assert.equal(await check.getByTestId("control-chat-about").evaluate((link) => link.tagName), "BUTTON", "the conversation opens from its name");
  assert.equal(await check.locator(".control-via").textContent(), "Decision model 96%");
  assert.deepEqual(await check.locator(".control-action").allTextContents(), ["Push it on", "Done", "Abandon", "Open"]);
  // A finished card can be closed from the board too.
  assert.equal(await page.locator('[data-key="p1:c3"]').getByTestId("control-card-action-done").isVisible(), true);

  // Bob's settings are saved with the account; pausing shows a banner with a way back.
  await page.getByTestId("control-chat-settings-button").click();
  await page.getByTestId("control-bob-threshold").fill("75");
  await page.getByTestId("control-bob-threshold").dispatchEvent("change");
  await page.getByTestId("control-bob-ask").check();
  await page.waitForFunction(async () => {
    const saved = await (await fetch("/api/control-center/bob/settings")).json();
    return saved.threshold === 0.75 && saved.askBeforeSaving === true;
  });
  await page.getByTestId("control-chat-settings-button").click();
  await page.getByTestId("control-chat-monitor").click();
  await page.getByTestId("control-chat-paused").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("control-chat-monitor").textContent(), "Paused");
  await page.getByRole("button", { name: "Restore" }).click();
  await page.getByTestId("control-chat-paused").waitFor({ state: "hidden" });

  // The chat moves to the other side and is resized by its edge; both stay with the account.
  await page.getByTestId("control-chat-side").click();
  assert.equal(await page.locator(".control-main.chat-left").count(), 1);
  const handle = (await page.getByTestId("control-chat-resize").boundingBox())!;
  await page.mouse.move(handle.x + 3, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x + 203, handle.y + 100);
  await page.mouse.up();
  const width = await page.getByTestId("control-chat").evaluate((chat) => chat.getBoundingClientRect().width);
  assert.ok(width > 450, `dragging the edge widened the chat, got ${width}`);
  await page.waitForFunction(async () => {
    const saved = await (await fetch("/api/preferences")).json();
    return saved.controlCenter.chatSide === "left" && saved.controlCenter.chatWidth > 450;
  });

  // Exit and Esc both leave.
  await page.getByTestId("control-center-close-button").click();
  assert.equal(await page.locator("body.view-control").count(), 0);
  await page.getByTestId("projects-open-control-center-button").click();
  await page.waitForSelector('[data-testid="control-center-card"]');
  // The side bars are not shown here; Esc once asks, and Esc again leaves.
  assert.equal(await page.locator("#projectsPanel").isVisible(), false);
  assert.equal(await page.locator("#chatsPanel").isVisible(), false);
  await page.keyboard.press("Escape");
  await page.getByTestId("control-exit-prompt").waitFor({ state: "visible" });
  assert.equal(await page.locator("body.view-control").count(), 1, "one Esc does not leave");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("body.view-control").count(), 0);
  assert.equal(await page.getByTestId("control-exit-prompt").isVisible(), false);
});
