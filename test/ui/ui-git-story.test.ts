import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
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
  await openGit(page, environment, node.url);
  await page.getByTestId("git-review-tab-story").click();
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
  assert.equal(await page.getByTestId("git-review-story-dot").isVisible(), true);

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

  await page.getByTestId("git-review-tab-changes").click();
  assert.equal(await page.getByTestId("git-review-generate").innerText(), "Generate review comments");
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
  await openGit(page, environment, node.url);
  await page.waitForFunction(() => !document.querySelector("#gitReviewStoryDot")?.hidden);
  assert.match(await page.getByTestId("git-review-story-dot").getAttribute("class") ?? "", /is-outdated/);
  await page.getByTestId("git-review-tab-story").click();
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
  await openGit(page, environment, node.url);
  await page.getByTestId("git-review-tab-story").click();
  await page.getByTestId("git-story-empty").waitFor();
  // Nothing in this conversation to explain: generating it is off, picking is the way forward.
  await page.waitForFunction(() => (document.querySelector("[data-testid=git-story-generate]") as HTMLButtonElement | null)?.disabled === true);
  assert.equal(await page.getByTestId("git-review-generate").isDisabled(), true, "the reviewer bar cannot start an empty story either");
  await page.getByTestId("git-story-pick").click();
  await page.getByTestId("git-story-push").first().waitFor();
  assert.equal(await page.locator("#gitReviewToolbar").isVisible(), false, "the conversation scope toolbar is hidden while picking");
  assert.equal(await page.getByTestId("git-story-push").count(), 2);
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
