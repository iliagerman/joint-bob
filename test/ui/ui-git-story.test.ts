import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Page, Route } from "playwright";
import { nativeUiFixture } from "./native-ui-fixture.js";

const facts = {
  conversation: true,
  turns: [
    { n: 1, at: "2026-10-05T10:00:00.000Z", user: "Add a greeting", commits: ["abc1234"], paths: ["app.ts"] },
    { n: 2, at: "2026-10-05T10:20:00.000Z", user: "Show an error when the name is empty", commits: [], paths: ["app.ts", "app.test.ts"] },
  ],
  commits: [{ hash: "abc1234abc1234", shortHash: "abc1234", subject: "feat: greet", turn: 1 }],
  files: [
    { path: "app.ts", kind: "modified", add: 3, del: 1, where: ["abc1234", "pending"], area: "root" },
    { path: "app.test.ts", kind: "added", add: 5, del: 0, where: ["pending"], area: "root" },
  ],
};
const written = {
  kind: "Feature",
  title: "Greeting with an empty-name error",
  overview: { what: "The page greets the user by name.", why: "Users asked to be greeted.", notice: ["An empty name shows an error."], unchanged: "Unchanged: login." },
  diagram: {
    lanes: [{ id: "user", label: "User" }, { id: "server", label: "Server" }],
    nodes: [
      { id: "type", lane: "user", kind: "action", label: "Type a name", sub: "form", text: "The user types a name.", files: ["app.ts"] },
      { id: "check", lane: "server", kind: "decision", label: "Name empty?", sub: "", text: "The server checks the name.", files: ["app.ts"] },
      { id: "greet", lane: "user", kind: "action", label: "Show greeting", sub: "", text: "The page says hello.", files: [] },
      { id: "fail", lane: "user", kind: "error", label: "Show error", sub: "", text: "The page asks for a name.", files: ["app.ts"] },
    ],
    edges: [
      { from: "type", to: "check", label: "", style: "solid" },
      { from: "check", to: "greet", label: "no", style: "solid" },
      { from: "check", to: "fail", label: "yes", style: "bad" },
    ],
  },
  timeline: [
    { turns: [1], title: "Added the greeting", did: ["Greets by name."], decided: ["Plain text."], pivot: "", quiet: false },
    { turns: [2], title: "Handled empty names", did: ["Shows an error."], decided: [], pivot: "Errors show inline instead of in a dialog.", quiet: false },
  ],
  examples: [
    { kind: "Happy path", title: "Greet Ada", start: "The form is empty.", steps: [
      { you: "Type Ada.", app: "Sends the name.", says: "", nodes: ["type", "check"], edges: ["type>check"] },
      { you: "", app: "Shows the greeting.", says: "Hello, Ada", nodes: ["check", "greet"], edges: ["check>greet"] },
    ], result: "Hello, Ada appears." },
    { kind: "Failure", title: "Empty name", start: "The form is empty.", steps: [{ you: "Submit.", app: "Shows an error.", says: "Enter a name", nodes: ["check", "fail"], edges: ["check>fail"] }], result: "An error appears." },
  ],
  implementation: {
    what: { "app.ts": "Greets and validates the name.", "app.test.ts": "Covers the empty name." },
    decisions: [{ title: "Inline error", why: "Keeps focus in the form.", instead: "A dialog.", turn: 2 }],
    checks: [{ priority: "high", text: "Empty names never reach the server.", file: "app.ts" }],
    tests: [{ file: "app.test.ts", name: "rejects an empty name" }],
  },
};
const patches = [
  { path: "app.ts", source: "abc1234", patch: "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1,2 @@\n-old greeting\n+export const greet = (name) => `Hello, ${name}`;\n+// committed" },
  { path: "app.ts", source: "pending", patch: "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1,2 +1,2 @@\n export const greet = (name) => `Hello, ${name}`;\n-// committed\n+if (!name) throw new Error(\"Enter a name\");" },
  { path: "app.test.ts", source: "pending", patch: "diff --git a/app.test.ts b/app.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/app.test.ts\n@@ -0,0 +1 @@\n+test(\"rejects an empty name\")" },
];
const thread = { id: "story-1", harnessId: "pi", provider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "xhigh", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };
const saved = { story: written, facts, patches, fingerprint: "f", sources: { scope: "conversation", pendingPaths: ["app.ts", "app.test.ts"], includeCommits: true }, generatedAt: thread.createdAt };

async function openGit(page: Page, environment: { username: string; password: string }, url: string) {
  await page.goto(url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  // The conversation becomes active a moment after its card is clicked; until then Git opens project-wide.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.getByTestId("chat-git-button").click();
    if (await page.locator("#gitReviewContext").textContent() === "Conversation changes") return;
    await page.getByTestId("git-review-close-button").click();
    await page.waitForTimeout(250);
  }
  throw new Error("The conversation never became active");
}

// The story is its own view, not a Git tab. This opens it as the app does for a story the reader already has,
// without choosing the podcast or the Activity overview, so a test sees the story page itself.
async function openStoryView(page: Page, environment: { username: string; password: string }, url: string) {
  await page.goto(url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.evaluate(async () => {
      const { activeChatSession } = await import("/app/terminal.js");
      const { openGitReview } = await import("/app/git-review.js");
      const session = activeChatSession();
      if (session) await openGitReview(session.conversationId ?? session.id, { tab: "story" });
    });
    if (await page.locator("#gitReviewContext").textContent() === "Conversation changes") return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
  throw new Error("The conversation never became active");
}

async function mockReviewers(page: Page) {
  await page.route("**/api/harnesses", (route) => route.fulfill({ json: { harnesses: [
    { id: "pi", label: "Pi", runtimeConfigured: true, ready: true, defaults: { modelId: "gpt-6-sol", thinkingLevel: "xhigh" }, configuration: { fixedProvider: "openai-codex", thinkingLevels: ["low", "xhigh"] } },
    { id: "claude", label: "Claude", runtimeConfigured: true, ready: true, defaults: { modelId: "opus", thinkingLevel: "xhigh" }, configuration: { fixedProvider: "claude", thinkingLevels: ["low", "xhigh"] } },
  ] } }));
  await page.route("**/api/models", (route) => route.fulfill({ json: { models: [
    { harnessId: "pi", id: "gpt-6-sol", label: "GPT-6 Sol", provider: "openai-codex", thinkingLevels: ["low", "medium", "xhigh"] },
    { harnessId: "claude", id: "opus", label: "Opus 5.5", provider: "claude", thinkingLevels: ["low", "xhigh"] },
  ] } }));
}

const status = { branch: "main", upstream: "origin/main", ahead: 1, behind: 0, detached: false, staged: [], unstaged: [{ path: "app.ts", kind: "modified", staged: false }, { path: "other.ts", kind: "modified", staged: false }], untracked: [{ path: "app.test.ts", kind: "untracked", staged: false }], clean: false };

test("Story tab writes a story out of band, explains it in four sections, and opens side-by-side diffs", { timeout: 150_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const posts: Array<Record<string, unknown>> = [];
  let reply: "ok" | "reject" = "reject";
  await page.route("**/api/projects/*/git/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/status")) return route.fulfill({ json: status });
    if (url.pathname.endsWith("/scope")) return route.fulfill({ json: { paths: ["app.ts", "app.test.ts"], lastHarness: "claude" } });
    if (url.pathname.endsWith("/guide-latest")) return route.fulfill({ json: { latest: null } });
    if (url.pathname.endsWith("/story-latest")) return route.fulfill({ json: { latest: null, commits: [{ shortHash: "abc1234", subject: "feat: greet" }] } });
    if (url.pathname.endsWith("/story")) {
      posts.push(route.request().postDataJSON());
      if (reply === "reject") return route.fulfill({ status: 422, json: { error: "Story rejected. It mentions src/server/realtime.ts in Implementation, Components, which is not part of these changes." } });
      return route.fulfill({ json: { thread, saved, freshness: { fresh: true, newTurns: 0, changedPaths: [] } } });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected Git request" } });
  });
  await mockReviewers(page);
  await openStoryView(page, environment, node.url);
  await page.getByTestId("git-story-empty").waitFor();
  assert.match(await page.getByTestId("git-review-story-commits").locator("..").innerText(), /\(1\)/);
  assert.equal(await page.getByTestId("git-review-generate").innerText(), "Generate story");

  await page.getByTestId("git-story-generate").click();
  await page.getByTestId("git-story-rejected").waitFor();
  assert.match(await page.getByTestId("git-story-rejected").innerText(), /src\/server\/realtime\.ts/);
  assert.equal(await page.getByTestId("git-review-generate").innerText(), "Try again");

  reply = "ok";
  await page.getByTestId("git-review-generate").click();
  await page.getByTestId("git-story-title").waitFor();
  assert.equal(await page.getByTestId("git-story-title").innerText(), "Greeting with an empty-name error");
  assert.equal(await page.getByTestId("git-story-omitted").count(), 0, "a story that fits names no left-out diffs");
  const { conversationId, ...request } = posts.at(-1) as { conversationId: string };
  assert.ok(conversationId);
  assert.deepEqual(request, { scope: "conversation", paths: ["app.ts", "app.test.ts"], includeCommits: true, harnessId: "pi", provider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "medium" });

  // The dialog never scrolls the page; the story fits inside it.
  const fit = await page.evaluate(() => ({ page: document.scrollingElement!.scrollHeight <= innerHeight, card: (() => { const card = document.querySelector(".git-review-card")!; return card.scrollHeight <= card.clientHeight + 1; })() }));
  assert.deepEqual(fit, { page: true, card: true });

  await page.locator(".gs-node", { hasText: "Name empty?" }).click();
  await page.getByTestId("git-story-step-card").waitFor();
  await page.getByTestId("git-story-step-card").getByTestId("git-story-show-diff").click();
  await page.getByTestId("git-diff-dialog").waitFor();
  assert.equal(await page.getByTestId("git-diff-title").innerText(), "app.ts");
  assert.equal(await page.getByTestId("git-diff-section").count(), 2, "one section per commit and the pending change");
  assert.match(await page.getByTestId("git-diff-body").innerText(), /Commit abc1234 · feat: greet[\s\S]*Pending, not committed/);
  const columns = await page.getByTestId("git-diff-section").first().locator(".git-diff-row").first().locator(".git-diff-cell").count();
  assert.equal(columns, 4, "rows are side by side: number, before, number, after");
  await page.getByTestId("git-diff-close-button").click();
  await page.getByTestId("git-diff-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("git-review-dialog").isVisible(), true, "closing the diff returns to the story");

  await page.getByTestId("git-story-section-conversation").click();
  assert.equal(await page.getByTestId("git-story-phase").count(), 2);
  await page.getByTestId("git-story-phase").nth(1).click();
  const conversation = await page.getByTestId("git-story-panel").innerText();
  assert.match(conversation, /Errors show inline instead of in a dialog/);
  assert.match(conversation, /Show an error when the name is empty/, "You asked quotes the user's own message");
  assert.match(conversation, /2 turns[^\n]*1 commit ·[^\n]*1 change of direction ·/);

  await page.getByTestId("git-story-section-examples").click();
  await page.getByTestId("git-story-step").nth(1).click();
  assert.equal(await page.locator(".gs-node.is-current").count(), 2);
  assert.match(await page.getByTestId("git-story-panel").innerText(), /Hello, Ada/);

  await page.getByTestId("git-story-section-implementation").click();
  assert.equal(await page.getByTestId("git-story-file").count(), 2);
  await page.getByTestId("git-story-file").filter({ hasText: "app.test.ts" }).getByTestId("git-story-show-diff").click();
  await page.getByTestId("git-diff-dialog").waitFor();
  assert.match(await page.getByTestId("git-diff-body").innerText(), /rejects an empty name/);
  await page.keyboard.press("Escape");
  await page.getByTestId("git-diff-dialog").waitFor({ state: "hidden" });

  await page.getByTestId("git-story-pull-input").fill("https://github.com/acme/widget/pull/42");
  const prRequest = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/git/story") && request.method() === "POST");
  await page.getByTestId("git-story-pull-generate").click();
  const prPayload = (await prRequest).postDataJSON();
  assert.equal(prPayload.source, "pull");
  assert.equal(prPayload.pullNumber, 42);
  assert.equal(prPayload.pullUrl, "https://github.com/acme/widget/pull/42");
  assert.deepEqual(prPayload.paths, []);
  await page.getByTestId("git-story-title").waitFor();
  assert.equal(await page.getByTestId("git-review-tab-changes").isVisible(), false, "the story has no Git tabs");
  assert.equal(await page.locator("#gitReviewTitle").innerText(), "Story");
});

test("Story failures show and copy server diagnostics instead of blaming the reviewer", { timeout: 150_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const reason = "Claude session path is outside Claude projects";
  const details = `${reason}\nStatus: 500\nStage: Reading conversation and changes\nServer: fixture-homeserver\nTime: 2026-10-29T18:41:23.000Z\nProject: fixture-project\nConversation: fixture-conversation\nReviewer: pi / test-model`;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  let streamed = true;
  await page.route("**/api/projects/*/git/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/status")) return route.fulfill({ json: status });
    if (url.pathname.endsWith("/scope")) return route.fulfill({ json: { paths: ["app.ts"], lastHarness: "claude" } });
    if (url.pathname.endsWith("/guide-latest")) return route.fulfill({ json: { latest: null } });
    if (url.pathname.endsWith("/story-latest")) return route.fulfill({ json: { latest: null, commits: [] } });
    if (url.pathname.endsWith("/story")) {
      const failure = { type: "error", status: 500, error: reason, details };
      return streamed
        ? route.fulfill({ contentType: "application/x-ndjson", body: `${JSON.stringify(failure)}\n` })
        : route.fulfill({ status: 500, json: failure });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected Git request" } });
  });
  await mockReviewers(page);
  await openStoryView(page, environment, node.url);
  for (const format of ["stream", "json"]) {
    streamed = format === "stream";
    await page.getByTestId("git-review-generate").click();
    const panel = page.getByTestId("git-story-rejected");
    await panel.waitFor();
    assert.equal(await panel.locator("h3").innerText(), "Could not write the story");
    assert.match(await panel.innerText(), /Claude session path is outside Claude projects/);
    await panel.locator("summary").click();
    assert.equal(await page.getByTestId("git-story-error-details").innerText(), details);
    await page.getByTestId("git-story-copy-error").click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), details);
  }
});

test("Story tab opens each section while the reviewer is still writing the rest", { timeout: 150_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  // The story route streams JSON lines; the test pushes each line when it wants the next state.
  // A string, not a function: the test compiler would add helpers the page does not have.
  await page.addInitScript(`
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (!new URL(String(input), location.href).pathname.endsWith("/git/story")) return realFetch(input, init);
      window.storyHeaders = Object.fromEntries(new Headers(init && init.headers).entries());
      const encoder = new TextEncoder();
      const body = new ReadableStream({ start(controller) {
        window.storyStream = { push: (line) => controller.enqueue(encoder.encode(JSON.stringify(line) + "\\n")), end: () => controller.close() };
      } });
      return Promise.resolve(new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }));
    };
  `);
  await page.route("**/api/projects/*/git/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/status")) return route.fulfill({ json: status });
    if (url.pathname.endsWith("/scope")) return route.fulfill({ json: { paths: ["app.ts", "app.test.ts"], lastHarness: "claude" } });
    if (url.pathname.endsWith("/guide-latest")) return route.fulfill({ json: { latest: null } });
    if (url.pathname.endsWith("/story-latest")) return route.fulfill({ json: { latest: null, commits: [{ shortHash: "abc1234", subject: "feat: greet" }] } });
    return route.fulfill({ status: 404, json: { error: "Unexpected Git request" } });
  });
  const push = (...lines: unknown[]) => page.evaluate((items) => {
    const win = window as unknown as { storyStream: { push: (line: unknown) => void } };
    for (const line of items) win.storyStream.push(line);
  }, lines);
  const section = (name: string, data: unknown) => ({ type: "section", section: name, data });
  await mockReviewers(page);
  await openStoryView(page, environment, node.url);
  await page.getByTestId("git-story-generate").click();
  await page.getByTestId("git-story-writing").waitFor();
  await page.waitForFunction(() => Boolean((window as unknown as { storyStream?: unknown }).storyStream));
  const headers = await page.evaluate(() => (window as unknown as { storyHeaders: Record<string, string> }).storyHeaders);
  assert.ok(headers["x-csrf-token"], "the streamed request carries the CSRF token");
  assert.match(headers.accept, /application\/x-ndjson/);
  assert.match(await page.getByTestId("git-story-writing").innerText(), /Reading the changes/);

  await push({ type: "facts", facts, patches, sources: saved.sources }, section("title", { kind: written.kind, title: written.title }), section("overview", written.overview));
  await page.getByTestId("git-story-progress").waitFor();
  assert.equal(await page.getByTestId("git-story-title").innerText(), "Greeting with an empty-name error");
  assert.match(await page.getByTestId("git-story-progress").innerText(), /1 of 5 parts written/);
  assert.match(await page.getByTestId("git-story-panel").innerText(), /The page greets the user by name\.[\s\S]*drawing the flow diagram/);
  assert.match(await page.getByTestId("git-story-section-implementation").innerText(), /Being written/);
  await page.getByTestId("git-story-section-implementation").click();
  await page.getByTestId("git-story-panel").getByTestId("git-story-pending").waitFor();

  await push(section("diagram", written.diagram), section("timeline", written.timeline), section("examples", written.examples));
  await page.getByTestId("git-story-section-examples").click();
  await page.getByTestId("git-story-step").first().waitFor();
  assert.match(await page.getByTestId("git-story-progress").innerText(), /4 of 5 parts written/);

  await page.getByTestId("git-story-section-implementation").click();
  await push(section("implementation", written.implementation));
  await page.getByTestId("git-story-file").first().waitFor();
  assert.equal(await page.getByTestId("git-story-file").count(), 2);
  await push({ type: "checking" });
  await page.getByTestId("git-story-progress").filter({ hasText: "Checking" }).waitFor();

  await push({ type: "done", thread, saved, freshness: { fresh: true, newTurns: 0, changedPaths: [] } });
  await page.evaluate(() => (window as unknown as { storyStream: { end: () => void } }).storyStream.end());
  await page.getByTestId("git-story-progress").waitFor({ state: "detached" });
  assert.equal(await page.getByTestId("git-story-file").count(), 2, "the reader stays on the section they were reading");
  assert.equal(await page.getByTestId("git-review-generate").innerText(), "Regenerate story");
});

test("Story tab opens on the first finished section even when the overview is still being written", { timeout: 150_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.addInitScript(`
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (!new URL(String(input), location.href).pathname.endsWith("/git/story")) return realFetch(input, init);
      const encoder = new TextEncoder();
      const body = new ReadableStream({ start(controller) {
        window.storyStream = { push: (line) => controller.enqueue(encoder.encode(JSON.stringify(line) + "\\n")), end: () => controller.close() };
      } });
      return Promise.resolve(new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }));
    };
  `);
  await page.route("**/api/projects/*/git/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/status")) return route.fulfill({ json: status });
    if (url.pathname.endsWith("/scope")) return route.fulfill({ json: { paths: ["app.ts", "app.test.ts"], lastHarness: "claude" } });
    if (url.pathname.endsWith("/guide-latest")) return route.fulfill({ json: { latest: null } });
    if (url.pathname.endsWith("/story-latest")) return route.fulfill({ json: { latest: null, commits: [{ shortHash: "abc1234", subject: "feat: greet" }] } });
    return route.fulfill({ status: 404, json: { error: "Unexpected Git request" } });
  });
  await mockReviewers(page);
  await openStoryView(page, environment, node.url);
  await page.getByTestId("git-story-generate").click();
  await page.getByTestId("git-story-writing").waitFor();
  await page.waitForFunction(() => Boolean((window as unknown as { storyStream?: unknown }).storyStream));
  await page.evaluate((items) => {
    const win = window as unknown as { storyStream: { push: (line: unknown) => void } };
    for (const line of items) win.storyStream.push(line);
  }, [{ type: "facts", facts, patches, sources: saved.sources }, { type: "section", section: "diagram", data: written.diagram }, { type: "section", section: "timeline", data: written.timeline }]);
  // No title and no overview yet: the conversation section is finished, so it opens instead of the progress card.
  await page.getByTestId("git-story-progress").waitFor();
  assert.match(await page.getByTestId("git-story-panel").innerText(), /Added the greeting/);
  assert.equal(await page.getByTestId("git-story-writing").count(), 0);
});

test("the activity panel Story button writes a conversation's first story once, and a jump to the chat leads back to the same page", { timeout: 150_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const posts: Array<Record<string, unknown>> = [];
  let latest: unknown = null;
  await page.route("**/api/projects/*/git/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/status")) return route.fulfill({ json: status });
    if (url.pathname.endsWith("/scope")) return route.fulfill({ json: { paths: ["app.ts", "app.test.ts"], lastHarness: "claude" } });
    if (url.pathname.endsWith("/guide-latest")) return route.fulfill({ json: { latest: null } });
    if (url.pathname.endsWith("/story-latest")) return route.fulfill({ json: { latest, commits: [{ shortHash: "abc1234", subject: "feat: greet" }] } });
    if (url.pathname.endsWith("/story")) {
      posts.push(route.request().postDataJSON());
      latest = { thread, saved, freshness: { fresh: true, newTurns: 0, changedPaths: [] } };
      return route.fulfill({ json: latest });
    }
    // The narrator check runs on this test's node, which has no local voice and no ElevenLabs account.
    if (url.pathname.endsWith("/story-voice")) return route.continue();
    return route.fulfill({ status: 404, json: { error: "Unexpected Git request" } });
  });
  await mockReviewers(page);
  await openGit(page, environment, node.url);
  await page.getByTestId("git-review-close-button").click();
  if (await page.getByTestId("chat-activity-toggle").getAttribute("aria-expanded") !== "true") await page.getByTestId("chat-activity-toggle").click();

  // The first story on this node asks which voice narrates, and keeps the answer.
  await page.getByTestId("activity-story-button").click();
  const voiceQuestion = page.getByTestId("choice-dialog");
  await voiceQuestion.waitFor();
  assert.equal(await page.locator("#choiceTitle").innerText(), "Which voice should narrate?");
  const options = page.getByTestId("choice-option");
  assert.deepEqual((await options.allInnerTexts()).map((text) => text.split("\n")[0]), ["Open-source voice (Kokoro)", "ElevenLabs", "No voice"]);
  assert.match(await options.nth(1).innerText(), /ElevenLabs secret/, "an option that cannot work yet says what it needs");
  await options.nth(2).click();
  await page.getByTestId("choice-accept-button").click();
  await page.getByTestId("git-story-title").waitFor();
  const stored = await page.evaluate(async () => (await (await fetch("/api/story-settings")).json()).settings);
  assert.deepEqual({ narrate: stored.narrate, voiceChosen: stored.voiceChosen }, { narrate: false, voiceChosen: true });
  assert.equal(await page.getByTestId("git-story-podcast").count(), 0, "Story opens the written story, not the Activity overview movie");
  const { conversationId, ...request } = posts[0] as { conversationId: string };
  assert.ok(conversationId);
  assert.deepEqual(request, { source: "conversation", scope: "conversation", paths: ["app.ts", "app.test.ts"], includeCommits: true, harnessId: "pi", provider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "medium" });
  assert.equal(await page.locator("#gitReviewAllChanges").isChecked(), false, "the story stays on this conversation's own files");

  await page.getByTestId("git-story-section-conversation").click();
  await page.getByTestId("git-story-phase").nth(1).click();
  assert.match(await page.getByTestId("git-story-panel").innerText(), /Errors show inline instead of in a dialog/);
  // The chat needs the turn's bubble on screen for the jump to find it.
  await page.evaluate(() => {
    const bubble = document.createElement("div");
    bubble.className = "message user";
    bubble.innerHTML = '<div class="message-content">Show an error when the name is empty</div>';
    document.querySelector("#messages")!.append(bubble);
  });
  await page.getByTestId("git-story-open-turn").click();
  await page.getByTestId("git-story-return").waitFor();
  assert.equal(await page.locator("#gitReviewDialog").evaluate((dialog: HTMLDialogElement) => dialog.open), false, "the jump shows the chat");

  await page.getByTestId("git-story-return").click();
  assert.equal(await page.locator("#gitReviewDialog").evaluate((dialog: HTMLDialogElement) => dialog.open), true);
  assert.match(await page.getByTestId("git-story-panel").innerText(), /Errors show inline instead of in a dialog/, "back on the phase the reader left");
  assert.equal(await page.getByTestId("git-story-return").isVisible(), false);

  // Closing and using the button again opens the saved story on the same page; nothing is written twice.
  await page.getByTestId("git-review-close-button").click();
  await page.getByTestId("activity-story-button").click();
  await page.getByTestId("git-story-title").waitFor();
  assert.equal(await voiceQuestion.isVisible(), false, "the voice is asked only once on this node");
  await page.getByTestId("git-story-phase").nth(1).waitFor();
  assert.match(await page.getByTestId("git-story-panel").innerText(), /Errors show inline instead of in a dialog/);
  assert.equal(await page.getByTestId("git-review-generate").innerText(), "Regenerate story");
  assert.equal(posts.length, 1, "a saved story is opened, not regenerated");
});

test("Story tab marks a saved story outdated and offers Regenerate", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.route("**/api/projects/*/git/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/status")) return route.fulfill({ json: status });
    if (url.pathname.endsWith("/scope")) return route.fulfill({ json: { paths: ["app.ts", "app.test.ts"], lastHarness: "claude" } });
    if (url.pathname.endsWith("/guide-latest")) return route.fulfill({ json: { latest: null } });
    if (url.pathname.endsWith("/story-latest")) return route.fulfill({ json: { latest: { thread, saved, freshness: { fresh: false, newTurns: 2, changedPaths: ["app.ts"] } }, commits: [] } });
    return route.fulfill({ status: 404, json: { error: "Unexpected Git request" } });
  });
  await mockReviewers(page);
  await openStoryView(page, environment, node.url);
  await page.getByTestId("git-story-outdated").waitFor();
  assert.match(await page.getByTestId("git-story-outdated").innerText(), /2 new turns and 1 changed file[\s\S]*app\.ts[\s\S]*Regenerate/);
  assert.equal(await page.getByTestId("git-review-generate").innerText(), "Regenerate story");
});

test("Story tab explains commits picked from past pushes or history, without the conversation", { timeout: 150_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const commit = (n: number, subject: string) => ({ hash: `${String(n).repeat(7)}${"0".repeat(33)}`, shortHash: String(n).repeat(7), author: "Ada", authorEmail: "ada@example.com", date: new Date(Date.now() - n * 3_600_000).toISOString(), subject, body: "" });
  const history = [commit(1, "chore(release): 2.40.0"), commit(2, "feat(git): add Story tab"), commit(3, "fix(secrets): mirrored workspace"), commit(4, "docs: release notes")];
  const older = commit(9, "feat: an old change beyond the loaded history");
  const pushes = [
    { ref: "origin/main", at: new Date(Date.now() - 3_600_000).toISOString(), from: history[2].hash, to: history[0].hash, commits: [history[0], history[1]], more: false },
    { ref: "origin/main", at: new Date(Date.now() - 7_200_000).toISOString(), from: null, to: history[2].hash, commits: [history[2]], more: false },
  ];
  const posts: Array<Record<string, unknown>> = [];
  const picked = {
    ...saved,
    facts: { conversation: false, turns: [], commits: [{ hash: history[1].hash, shortHash: history[1].shortHash, subject: history[1].subject, turn: 0, date: history[1].date }, { hash: history[0].hash, shortHash: history[0].shortHash, subject: history[0].subject, turn: 0, date: history[0].date }], files: facts.files.map((file) => ({ ...file, where: [history[1].shortHash] })), omitted: ["app.ts"] },
    story: { ...written, timeline: [], implementation: { ...written.implementation, decisions: [{ ...written.implementation.decisions[0], turn: null }] } },
    sources: { kind: "commits", scope: "all", pendingPaths: [], includeCommits: false, commits: [history[0].hash, history[1].hash] },
  };
  await page.route("**/api/projects/*/git/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/status")) return route.fulfill({ json: { ...status, unstaged: [], untracked: [], clean: true } });
    if (url.pathname.endsWith("/scope")) return route.fulfill({ json: { paths: [], lastHarness: "claude" } });
    if (url.pathname.endsWith("/guide-latest")) return route.fulfill({ json: { latest: null } });
    if (url.pathname.endsWith("/story-latest")) return route.fulfill({ json: { latest: null, commits: [] } });
    if (url.pathname.endsWith("/pushes")) return route.fulfill({ json: { pushes } });
    if (url.pathname.endsWith("/history")) return route.fulfill({ json: { commits: history } });
    if (url.pathname.endsWith("/commit")) {
      const revision = url.searchParams.get("revision");
      return revision === older.shortHash ? route.fulfill({ json: { ...older, files: [], diff: { patch: "", binary: false, truncated: false } } }) : route.fulfill({ status: 404, json: { error: "Commit not found" } });
    }
    if (url.pathname.endsWith("/story")) {
      posts.push(route.request().postDataJSON());
      return route.fulfill({ json: { thread, saved: picked, freshness: { fresh: true, newTurns: 0, changedPaths: [] } } });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected Git request" } });
  });
  await mockReviewers(page);
  await openStoryView(page, environment, node.url);
  await page.getByTestId("git-story-empty").waitFor();
  // Nothing in this conversation to explain: generating it is off, picking is the way forward.
  await page.waitForFunction(() => (document.querySelector("[data-testid=git-story-generate]") as HTMLButtonElement | null)?.disabled === true);
  assert.equal(await page.getByTestId("git-review-generate").isDisabled(), true, "the reviewer bar cannot start an empty story either");
  await page.getByTestId("git-story-pick").click();
  await page.getByTestId("git-story-push").first().waitFor();
  assert.equal(await page.locator("#gitReviewToolbar").isVisible(), false, "the conversation scope toolbar is hidden while picking");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=git-story-push]").length === 2);
  assert.match(await page.getByTestId("git-story-push").first().innerText(), /Pushed to origin\/main[\s\S]*2 commits[\s\S]*chore\(release\): 2\.40\.0 · feat\(git\): add Story tab/);
  assert.equal(await page.getByTestId("git-review-generate").isDisabled(), true);

  await page.getByTestId("git-story-push").first().getByTestId("git-story-pick-box").check();
  assert.match(await page.getByTestId("git-story-pick-summary").innerText(), /2 of 20 commits picked: 1111111, 2222222/);
  assert.equal(await page.getByTestId("git-review-generate").innerText(), "Generate story for 2 commits");

  await page.getByTestId("git-story-pick-commits").click();
  assert.equal(await page.getByTestId("git-story-pick-commit").count(), 4);
  assert.equal(await page.getByTestId("git-story-pick-commit").nth(1).getByTestId("git-story-pick-box").isChecked(), true, "picks carry across tabs");
  await page.getByTestId("git-story-pick-commit").nth(1).getByTestId("git-story-pick-box").uncheck();
  await page.getByTestId("git-story-pick-commit").nth(3).getByTestId("git-story-pick-box").check();
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.pick), history[3].hash, "focus stays on the toggled box");
  await page.getByTestId("git-story-pick-pushes").click();
  assert.equal(await page.getByTestId("git-story-push").first().getByTestId("git-story-pick-box").evaluate((box: HTMLInputElement) => box.indeterminate), true);

  await page.getByTestId("git-story-pick-hash").fill("9999999, not-a-hash 8888888");
  await page.getByTestId("git-story-pick-hash").press("Enter");
  await page.getByTestId("git-story-pick-type-error").waitFor();
  assert.match(await page.getByTestId("git-story-pick-summary").innerText(), /3 of 20 commits picked: .*9999999/);
  assert.match(await page.getByTestId("git-story-pick-type-error").innerText(), /not-a-hash is not a commit hash\. 8888888: Commit not found/);
  assert.equal(await page.getByTestId("git-story-pick-hash").inputValue(), "not-a-hash 8888888", "only the failed entries stay in the box");

  const fit = await page.evaluate(() => document.scrollingElement!.scrollHeight <= innerHeight);
  assert.equal(fit, true, "the picker never scrolls the page");

  await page.getByTestId("git-story-pick-generate").click();
  await page.getByTestId("git-story-title").waitFor();
  assert.equal(await page.getByTestId("git-story-omitted").innerText(), " · 1 diff too large to read");
  assert.match(await page.getByTestId("git-story-omitted").getAttribute("title") ?? "", /app\.ts/);
  const { conversationId, ...request } = posts.at(-1) as { conversationId: string };
  assert.ok(conversationId);
  assert.deepEqual(request, { source: "commits", commits: [history[0].hash, history[3].hash, older.hash], scope: "all", paths: [], includeCommits: false, harnessId: "pi", provider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "medium" });
  assert.equal(await page.locator("#gitReviewToolbar").isVisible(), false, "conversation scope does not apply to a commits story");
  assert.match(await page.getByTestId("git-story-section-conversation").innerText(), /Commits/);
  await page.getByTestId("git-story-section-conversation").click();
  assert.equal(await page.getByTestId("git-story-commit").count(), 2);
  assert.match(await page.getByTestId("git-story-panel").innerText(), /2222222[\s\S]*feat\(git\): add Story tab[\s\S]*1111111/);

  // Regenerating a commits story explains the same commits again, not the conversation.
  await page.getByTestId("git-review-generate").click();
  for (let wait = 0; wait < 50 && posts.length < 2; wait += 1) await page.waitForTimeout(100);
  await page.getByTestId("git-story-title").waitFor();
  assert.equal(posts.length, 2);
  assert.deepEqual((posts[1] as { commits: string[] }).commits, [history[0].hash, history[1].hash]);
  assert.equal(await page.getByTestId("git-story-explain-conversation").isVisible(), true);

  // From a saved story, the picker opens again and Back returns to the story.
  await page.getByTestId("git-story-pick").click();
  await page.getByTestId("git-story-picker").waitFor();
  await page.getByTestId("git-story-pick-cancel").click();
  await page.getByTestId("git-story-title").waitFor();
});

// A stand-in for the computer's voice: records what is spoken and finishes each line quickly.
const FAKE_SPEECH = `window.__spoken = [];
window.SpeechSynthesisUtterance = function (text) { this.text = text; };
Object.defineProperty(window, "speechSynthesis", { value: { speak(utterance) { window.__spoken.push(utterance.text); setTimeout(() => { utterance.onstart?.(); setTimeout(() => utterance.onend?.(), 300); }, 10); }, cancel() {}, pause() {}, resume() {} } });`;

const LOCATIONS = ["podcast", "classroom", "lecture", "coffeehouse", "street", "train", "server", "matrix", "rooftop"];
const storySettings = { instructions: "", backdrops: true, locations: LOCATIONS, moods: true, codeSlides: true, codeWriteup: true, maxCodeLines: 12, ask: true, narrate: true, hostVoice: "af_heart", cohostVoice: "am_michael", speed: 1, voiceChosen: true };
const recapItems = [["What changed", "Empty names are rejected."], ["Why", "Users saw a blank greeting."], ["What we give up", "Nothing."], ["How you notice", "An error shows."]].map(([label, text]) => ({ label, text }));
const script = {
  title: "Greeting with an empty-name error",
  chapters: [
    { title: "What went wrong", location: "server", mood: "tension", visual: { kind: "flow", nodes: [{ label: "Type a name", sub: "form", tone: "neutral" }, { label: "Name empty?", sub: "", tone: "bad" }], note: { title: "Result", text: "A blank greeting." } },
      lines: [{ who: "host", text: "Today we look at the greeting.", reveal: 1 }, { who: "cohost", text: "What went wrong?", reveal: 2 }] },
    { title: "The guard", location: "matrix", mood: "insight", visual: { kind: "code", file: "app.ts", lines: ["-// committed", "+if (!name) throw new Error(\"Enter a name\");"], steps: [{ from: 1, to: 1, note: "The old line goes." }, { from: 2, to: 2, note: "A new guard rejects empty names." }] },
      lines: [{ who: "host", text: "The old line goes away.", reveal: 1 }, { who: "host", text: "A guard rejects empty names.", reveal: 2 }] },
    { title: "Recap", location: "rooftop", mood: "resolved", visual: { kind: "recap", items: recapItems }, lines: [{ who: "host", text: "That is the whole change.", reveal: 4 }] },
  ],
  writeup: { changed: ["app.ts rejects an empty name."], how: ["The greeting checks the name first."], why: ["A blank greeting looked broken."], rejected: [{ option: "A dialog", why: "It steals focus." }], limits: ["Only checks for empty text."] },
  followUps: [],
  generatedAt: new Date().toISOString(),
};
const answered = {
  ...script,
  chapters: [...script.chapters, { title: "Why a guard", location: "coffeehouse", mood: "calm", question: "Why a guard?", visual: { kind: "compare", options: [{ title: "A guard", why: "Fails fast.", verdict: "yes" }, { title: "A default", why: "Hides the mistake.", verdict: "no" }] },
    lines: [{ who: "cohost", text: "Why a guard and not a default?", reveal: 1 }, { who: "host", text: "A default would hide the mistake.", reveal: 2 }] }],
  followUps: [{ question: "Why a guard?", answer: "A default would hide the mistake." }],
};

// A stand-in for audio playback: this Chrome cannot decode a clip, so each one "plays" briefly and then ends.
const FAKE_AUDIO = `window.Audio = class extends EventTarget { constructor(src = "") { super(); this.src = src; } pause() {} play() { if (!this.src) return Promise.reject(new Error("no source")); setTimeout(() => this.dispatchEvent(new Event("playing")), 5); setTimeout(() => this.onended?.(), 60); return Promise.resolve(); } removeAttribute() { this.src = ""; } hasAttribute() { return Boolean(this.src); } };`;

interface StoryFixture { voiceUpdatingChecks?: number; audioNeverStarts?: boolean; holdOverview?: Promise<void>; via?: "story" | "overview"; answerVoice?: string; settingsPuts?: Array<Record<string, unknown>>; installs?: number[]; overviewPosts?: Array<Record<string, unknown>>; storyCalls?: string[]; kokoro: boolean; narration?: number; script?: typeof script | null; settings?: Partial<typeof storySettings>; podcastPosts?: Array<Record<string, unknown>>; spoken?: Array<Record<string, unknown>> }

async function openSavedStory(page: Page, environment: { username: string; password: string }, url: string, fixture: StoryFixture) {
  await page.addInitScript(FAKE_SPEECH);
  await page.addInitScript(FAKE_AUDIO);
  // A clip that loads but never starts, as a browser does with audio it cannot play.
  if (fixture.audioNeverStarts) await page.addInitScript(`window.Audio = class extends EventTarget { constructor() { super(); this.src = ""; } pause() {} play() { return this.src ? Promise.resolve() : Promise.reject(new Error("no source")); } removeAttribute() { this.src = ""; } hasAttribute() { return Boolean(this.src); } };`);
  const settings = { ...storySettings, ...fixture.settings };
  await page.route("**/api/story-settings", (route) => {
    if (route.request().method() === "PUT") { fixture.settingsPuts?.push(route.request().postDataJSON()); Object.assign(settings, route.request().postDataJSON()); }
    return route.fulfill({ json: { settings, defaultInstructions: "default", locations: LOCATIONS.map((id) => ({ id, label: id })), voices: [{ id: "af_heart", label: "Heart" }], voice: { allowed: true, installed: fixture.kokoro, installing: false, installError: null, reason: null } } });
  });
  // The narrator belongs to the project, so the project's narration route answers it.
  const narration = async (route: Route) => {
    // The open-source voice updating itself: unavailable for a few checks, then ready.
    if (route.request().method() === "GET" && fixture.voiceUpdatingChecks) {
      fixture.voiceUpdatingChecks -= 1;
      return route.fulfill({ json: { provider: null, available: false, reason: "Local voice is being updated.", local: { allowed: true, installed: false, outdated: true, installing: true, installError: null, reason: null } } });
    }
    if (route.request().method() === "GET") return route.fulfill({ json: { provider: fixture.kokoro ? "kokoro" : null, available: fixture.kokoro, reason: fixture.kokoro ? null : "This project has no ElevenLabs key.", local: { allowed: true, installed: fixture.kokoro, installing: false, installError: null, reason: null } } });
    fixture.spoken?.push(route.request().postDataJSON());
    if (fixture.narration) return route.fulfill({ status: fixture.narration, json: { error: "The narrator could not speak the line." } });
    return route.fulfill({ contentType: "audio/wav", body: "RIFF" });
  };
  await page.route("**/api/projects/*/git/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/story-latest") || path.endsWith("/story")) fixture.storyCalls?.push(path);
    if (path.endsWith("/status")) return route.fulfill({ json: status });
    if (path.endsWith("/scope")) return route.fulfill({ json: { paths: ["app.ts", "app.test.ts"], lastHarness: "claude" } });
    if (path.endsWith("/guide-latest")) return route.fulfill({ json: { latest: null } });
    if (path.endsWith("/story-latest")) return route.fulfill({ json: { latest: { thread, saved, freshness: { fresh: true, newTurns: 0, changedPaths: [] } }, commits: [] } });
    if (path.endsWith("/overview")) {
      fixture.overviewPosts?.push(route.request().postDataJSON());
      await fixture.holdOverview;
      const lines = [{ type: "progress", stage: "Writing the movie" }, { type: "done", thread: { ...thread, id: "overview-1" }, script: fixture.script ?? script }];
      return route.fulfill({ contentType: "application/x-ndjson", body: lines.map((line) => JSON.stringify(line)).join("\n") });
    }
    if (path.endsWith("/story-podcast") && route.request().method() === "GET") return route.fulfill({ json: { script: fixture.script ?? null } });
    if (path.endsWith("/story-voice/install")) { fixture.installs?.push(Date.now()); return route.fulfill({ json: { local: { allowed: true, installed: false, installing: true, installError: null, reason: null } } }); }
    if (path.endsWith("/story-voice")) return narration(route);
    if (path.endsWith("/story-podcast")) {
      const body = route.request().postDataJSON() as { question?: string };
      fixture.podcastPosts?.push(body);
      const lines = [{ type: "progress", stage: "Writing with the reviewer" }, { type: "done", script: body.question ? answered : script }];
      return route.fulfill({ contentType: "application/x-ndjson", body: lines.map((line) => JSON.stringify(line)).join("\n") });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected Git request" } });
  });
  await mockReviewers(page);
  if (!fixture.via) { await openStoryView(page, environment, url); return; }
  await page.goto(url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  if (await page.getByTestId("chat-activity-toggle").getAttribute("aria-expanded") !== "true") await page.getByTestId("chat-activity-toggle").click();
  // The conversation becomes active a moment after its card is clicked.
  const opened = () => fixture.via === "overview" ? (fixture.overviewPosts?.length ?? 0) > 0 : page.locator("#gitReviewDialog[open]").count();
  for (let attempt = 0; attempt < 40 && !(await opened()); attempt += 1) {
    await page.getByTestId(fixture.via === "overview" ? "activity-overview-button" : "activity-story-button").click();
    if (fixture.answerVoice) {
      // Until the conversation is active the click only says so; once it is, the first-use voice question opens.
      try { await page.getByTestId("choice-dialog").waitFor({ timeout: 2_000 }); } catch { continue; }
      await page.getByTestId("choice-option").filter({ hasText: fixture.answerVoice }).click();
      await page.getByTestId("choice-accept-button").click();
    }
    await page.waitForTimeout(250);
  }
}

test("Story tab suggests a developer walkthrough that speaks with the computer's voice when no narrator is ready", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await openSavedStory(page, environment, node.url, { kokoro: false });
  await page.getByTestId("git-story-video-suggestion").waitFor();
  assert.match(await page.getByTestId("git-story-video-suggestion").innerText(), /Narration uses this computer's voice\.[\s\S]*Want spoken narration\?/);

  await page.getByTestId("git-story-video-play").click();
  const video = page.getByTestId("git-story-video");
  await video.waitFor();
  assert.match(await video.innerText(), /Greeting with an empty-name error/);
  assert.equal(await page.getByTestId("git-story-video-voice").innerText(), "Voice: this computer");
  assert.match(await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken[0]), /Greeting with an empty-name error/);
  const names = await page.locator(".gsv-seg").count();
  assert.ok(names >= 10, "flow, evolution, example steps, files, decisions, checks and tests each get a scene");
  await page.getByRole("button", { name: "Scene 4" }).click();
  await page.locator(".gsv-diagram .gs-node").first().waitFor();
  await page.getByRole("button", { name: "Scene 7" }).click();
  await page.locator(".gsv-diagram .gs-node.is-current").first().waitFor();
  await page.getByRole("button", { name: `Scene ${names - 2}` }).click();
  await page.locator(".gsv-priority.is-high").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await video.count(), 0);

  await page.getByTestId("git-story-video-silent").click();
  await video.waitFor();
  assert.equal(await page.getByTestId("git-story-video-voice").innerText(), "Voice off");
});

test("Story video narrates with the project's narrator and switches to the computer's voice, saying why, when it fails", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const spoken: Array<Record<string, unknown>> = [];
  await openSavedStory(page, environment, node.url, { kokoro: true, narration: 502, spoken });
  await page.getByTestId("git-story-video-play").click();
  await page.locator(".toast-message", { hasText: "Narration failed" }).waitFor();
  await page.getByText("Voice: this computer").waitFor();
  assert.equal(spoken[0].who, "host");
  assert.match(await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken[0]), /Greeting with an empty-name error/);
});

test("Activity overview writes the movie, moves between places, shows the code, and grows with a follow-up question", { timeout: 150_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const podcastPosts: Array<Record<string, unknown>> = [];
  const overviewPosts: Array<Record<string, unknown>> = [];
  const storyCalls: string[] = [];
  const spoken: Array<Record<string, unknown>> = [];
  await openSavedStory(page, environment, node.url, { kokoro: true, script: null, podcastPosts, overviewPosts, storyCalls, spoken, via: "overview" });
  const podcast = page.getByTestId("git-story-podcast");
  await podcast.waitFor();
  assert.equal(overviewPosts.length, 1);
  assert.equal(typeof overviewPosts[0].conversationId, "string");
  assert.equal((overviewPosts[0].settings as typeof storySettings).hostVoice, "af_heart");
  assert.deepEqual(storyCalls, [], "the movie never asks for, or writes, the change story");
  assert.equal(await page.locator("#gitReviewDialog[open]").count(), 0, "the movie does not open the Git or Story view");

  // Chapters carry a place each, and the slide builds as the lines are spoken.
  assert.match(await page.locator(".gsp-scene-chip").innerText(), /1 \/ 3 · Server room/);
  assert.equal(await page.locator(".gsp-chap").count(), 3);
  await page.locator(".gsp-chap", { hasText: "The guard" }).click();
  assert.match(await page.locator(".gsp-scene-chip").innerText(), /The matrix/);
  await page.locator(".gsp-hl.is-on").waitFor();
  assert.match(await page.locator(".gsp-callout.is-on").innerText(), /The old line goes/);
  assert.equal(await page.locator(".gsp-cl.add").count(), 1);
  await page.locator(".gsp-chap", { hasText: "Recap" }).click();
  assert.match(await page.locator(".gsp-scene-chip").innerText(), /Rooftop at dawn/);
  await page.locator(".gsp-rc.is-on").first().waitFor();

  // Each line is its own clip, and a finished clip moves on to the next line.
  await page.locator(".gsp-chap", { hasText: "What went wrong" }).click();
  await page.locator(".gsp-play").click();
  await page.locator(".gsp-play", { hasText: "Replay" }).waitFor();
  assert.deepEqual(spoken.slice(0, 2).map(({ text, who }) => ({ text, who })), [{ text: "Today we look at the greeting.", who: "host" }, { text: "What went wrong?", who: "cohost" }]);
  assert.equal((spoken[0].settings as typeof storySettings).hostVoice, "af_heart", "the voice chosen in Settings travels with each line");

  // The written section explains the code line by line.
  await page.getByTestId("git-story-podcast-writeup-tab").click();
  const writeup = page.getByTestId("git-story-podcast-writeup");
  assert.match(await writeup.innerText(), /app\.ts rejects an empty name[\s\S]*A dialog: It steals focus[\s\S]*line 2 A new guard rejects empty names/);
  await page.getByRole("button", { name: "Podcast", exact: true }).click();

  // A question continues the story: its answer becomes new chapters and joins the written section.
  await page.getByTestId("git-story-podcast-question").fill("Why a guard?");
  await page.getByTestId("git-story-podcast-ask").click();
  await page.locator(".gsp-chap.is-question").waitFor();
  assert.equal(podcastPosts[0].question, "Why a guard?");
  assert.equal(podcastPosts[0].threadId, "overview-1", "a follow-up continues the movie's own record");
  assert.equal(await page.locator(".gsp-chap").count(), 4);
  assert.match(await page.locator(".gsp-scene-chip").innerText(), /4 \/ 4 · Coffee house/);
  await page.getByTestId("git-story-podcast-writeup-tab").click();
  assert.match(await writeup.innerText(), /Your follow-up questions[\s\S]*Why a guard\? A default would hide the mistake/i);

  await page.keyboard.press("Escape");
  assert.equal(await podcast.count(), 0);
});

test("Activity overview follows the settings: one studio, no code slides, no mood, and says why it is silent", { timeout: 150_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const podcastPosts: Array<Record<string, unknown>> = [];
  await openSavedStory(page, environment, node.url, { kokoro: false, script, settings: { backdrops: false, moods: false, codeSlides: false, ask: false, codeWriteup: false }, podcastPosts, overviewPosts: [], via: "overview" });
  await page.getByTestId("git-story-podcast").waitFor();
  await page.locator(".toast-message", { hasText: "plays without sound. This project has no ElevenLabs key." }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Sound on" }).count(), 0, "a silent movie offers no sound switch");
  assert.deepEqual(podcastPosts, []);
  assert.equal(await page.locator(".gsp-chap").count(), 2, "the code chapter is dropped");
  assert.match(await page.locator(".gsp-scene-chip").innerText(), /Podcast studio/);
  assert.equal(await page.getByTestId("git-story-podcast-question").isVisible(), false);
  assert.equal(await page.locator(".gsp-play").innerText(), "▶ Play");
  await page.getByTestId("git-story-podcast-writeup-tab").click();
  assert.equal(await page.locator(".gsp-wcode").count(), 0);
});

test("Story saves as one HTML file with the walkthrough and the review notes", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await openSavedStory(page, environment, node.url, { kokoro: false });
  const download = page.waitForEvent("download");
  await page.getByTestId("git-story-video-export").click();
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "story-export-")), "story.html");
  await (await download).saveAs(file);
  const standalone = await page.context().newPage();
  await standalone.addInitScript(FAKE_SPEECH);
  const errors: string[] = [];
  standalone.on("pageerror", (error) => errors.push(error.message));
  await standalone.goto(`file://${file}`);
  await standalone.waitForTimeout(500);
  assert.deepEqual(errors, []);
  const notes = await standalone.locator(".gsn").innerText();
  assert.match(notes, /review checklist[\s\S]*Empty names never reach the server/i);
  assert.match(notes, /rejects an empty name/);
  await standalone.locator("#play").click();
  await standalone.locator(".gsv").waitFor();
  await standalone.getByRole("button", { name: "Scene 7" }).click();
  await standalone.locator(".gsv-diagram .gs-node.is-current").first().waitFor();
  assert.ok((await standalone.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.length)) >= 1);
  assert.deepEqual(errors, []);
});

test("Activity overview plays the stick-figure movie from the activity panel without a story, and the phone menu offers Story and Overview", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const overviewPosts: Array<Record<string, unknown>> = [];
  const storyCalls: string[] = [];
  let release!: () => void;
  const holdOverview = new Promise<void>((resolve) => { release = resolve; });
  await openSavedStory(page, environment, node.url, { kokoro: false, script: null, overviewPosts, storyCalls, holdOverview, via: "overview" });
  // While the writer works, a card says so, with the time so far, and the button shows it is busy.
  const progress = page.getByTestId("activity-overview-progress");
  await progress.waitFor();
  assert.match(await progress.innerText(), /Activity overview[\s\S]*\d:\d\d/);
  assert.equal(await page.getByTestId("activity-overview-button").getAttribute("aria-busy"), "true");
  release();
  const movie = page.getByTestId("git-story-podcast");
  await movie.waitFor();
  await progress.waitFor({ state: "detached" });
  assert.equal(await page.getByTestId("activity-overview-button").isDisabled(), false);
  assert.equal(overviewPosts.length, 1, "the movie is written from the conversation itself");
  assert.deepEqual(storyCalls, [], "no written story is requested or made");
  assert.match(await page.locator(".gsp-scene-chip").innerText(), /1 \/ 3 · Server room/);
  assert.equal(await page.getByTestId("git-story-video").count(), 0, "the older video walk-through does not open");
  assert.equal(await page.locator("#gitReviewDialog[open]").count(), 0, "the Story view stays closed");
  await page.getByRole("button", { name: "Close Activity overview" }).click();
  await movie.waitFor({ state: "detached" });
  await page.setViewportSize({ width: 390, height: 800 });
  assert.equal(await page.getByTestId("nav-story-button").isVisible(), true);
  assert.equal(await page.getByTestId("nav-overview-button").isVisible(), true);
  assert.equal(await page.getByTestId("nav-overview-button").getAttribute("aria-label"), "Activity overview");
});

test("the activity panel header keeps its tabs, Story and Overview on one row, each with an icon", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  if (await page.getByTestId("chat-activity-toggle").getAttribute("aria-expanded") !== "true") await page.getByTestId("chat-activity-toggle").click();
  await page.getByTestId("activity-modes").waitFor();
  const controls = ["activity-activity-tab", "activity-chat-tab", "activity-story-button", "activity-overview-button", "activity-panel-close"];
  const layout = await page.evaluate((ids) => {
    const header = document.querySelector<HTMLElement>(".activity-panel-header")!;
    return { middles: ids.map((id) => { const box = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect(); return Math.round(box.top + box.height / 2); }), fits: header.scrollWidth <= header.clientWidth };
  }, controls);
  assert.ok(Math.max(...layout.middles) - Math.min(...layout.middles) <= 2, `every control sits on one row, got ${JSON.stringify(layout.middles)}`);
  assert.equal(layout.fits, true, "the header fits the panel width without wrapping or overflow");
  for (const id of ["activity-activity-tab", "activity-chat-tab", "activity-story-button", "activity-overview-button"]) {
    assert.equal(await page.getByTestId(id).locator("svg").isVisible(), true, `${id} has an icon`);
  }
});

test("Activity overview asks once which voice narrates, saves it, and installs the open-source voice where the project is narrated", { timeout: 150_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const settingsPuts: Array<Record<string, unknown>> = [];
  const installs: number[] = [];
  const overviewPosts: Array<Record<string, unknown>> = [];
  await openSavedStory(page, environment, node.url, { kokoro: false, script, settings: { voiceChosen: false }, settingsPuts, installs, overviewPosts, answerVoice: "Open-source voice (Kokoro)", via: "overview" });
  await page.getByTestId("git-story-podcast").waitFor();
  assert.equal(settingsPuts.length, 1);
  assert.deepEqual({ voiceProvider: settingsPuts[0].voiceProvider, narrate: settingsPuts[0].narrate, voiceChosen: settingsPuts[0].voiceChosen }, { voiceProvider: "kokoro", narrate: true, voiceChosen: true });
  assert.equal(installs.length, 1, "the voice installs through the project's route, on the computer that narrates");
  assert.equal((overviewPosts[0].settings as { voiceProvider: string }).voiceProvider, "kokoro", "the movie uses the voice just chosen");
  await page.getByRole("button", { name: "Close Activity overview" }).click();
  await page.getByTestId("activity-overview-button").click();
  await page.getByTestId("git-story-podcast").waitFor();
  assert.equal(await page.getByTestId("choice-dialog").isVisible(), false, "the voice is asked once");
  assert.equal(settingsPuts.length, 1);
});

test("Activity overview says when the browser does not start the narration, and keeps the movie moving silently", { timeout: 150_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await openSavedStory(page, environment, node.url, { kokoro: true, script, audioNeverStarts: true, overviewPosts: [], via: "overview" });
  await page.getByTestId("git-story-podcast").waitFor();
  const first = await page.locator(".gsp-caption").innerText();
  await page.locator(".gsp-play").click();
  await page.locator(".toast-message", { hasText: "did not start the narration clip" }).waitFor({ timeout: 15_000 });
  await page.waitForFunction((text) => document.querySelector(".gsp-caption")?.textContent !== text, first, { timeout: 20_000 });
});

test("Activity overview waits while the open-source voice updates itself, then plays with sound instead of silently", { timeout: 150_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const spoken: Array<Record<string, unknown>> = [];
  await openSavedStory(page, environment, node.url, { kokoro: true, script, voiceUpdatingChecks: 2, spoken, overviewPosts: [], via: "overview" });
  await page.getByTestId("activity-overview-progress").filter({ hasText: "Updating the open-source voice" }).waitFor();
  await page.getByTestId("git-story-podcast").waitFor();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=activity-overview-progress]").length === 0);
  for (let wait = 0; wait < 50 && !spoken.length; wait += 1) await page.waitForTimeout(100);
  assert.ok(spoken.length > 0, "the first line is narrated once the voice is ready");
  assert.equal(await page.locator(".toast-message", { hasText: "plays without sound" }).count(), 0);
});
