import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

/** Builds a one-number script dashboard in the draft folder, like the real agent would. */
const fakeAgent = `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
export default async (input) => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const draft = /Draft folder \\(edit here\\): (.+)/.exec(input.prompt)[1].trim();
  await mkdir(draft, { recursive: true });
  await writeFile(path.join(draft, "manifest.json"), JSON.stringify({ title: "Bugs today", refresh: { method: "script", command: 'node "$JOINT_BOB_DASHBOARD_DIR/refresh.mjs"' } }));
  await writeFile(path.join(draft, "refresh.mjs"), "console.log(JSON.stringify({ generatedAt: new Date().toISOString(), bugs: 7 }))");
  await writeFile(path.join(draft, "index.html"), "<script>const data = JointBobKit.payload(); JointBobKit.mount(JointBobKit.kpi({ label: 'Bugs today', value: data.bugs ?? 0 }));</script>");
  return "I built a dashboard that shows today's bugs.";
};
`;

/** Reports a step and its text, shows a page early, then finishes the draft: time to watch it work. */
const slowAgent = `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export default async (input) => {
  const draft = /Draft folder \\(edit here\\): (.+)/.exec(input.prompt)[1].trim();
  await mkdir(draft, { recursive: true });
  input.onActivity({ tool: "bash", target: "psql -c 'select count(*) from errors'" });
  input.onText("Looking at the errors table");
  await wait(2500);
  await writeFile(path.join(draft, "index.html"), "<script>JointBobKit.mount(JointBobKit.kpi({ label: 'Errors today', value: JointBobKit.payload().errors ?? 0 }));</script>");
  input.onActivity({ tool: "write", target: "index.html" });
  await wait(2500);
  await writeFile(path.join(draft, "manifest.json"), JSON.stringify({ title: "Errors", refresh: { method: "script", command: 'node "$JOINT_BOB_DASHBOARD_DIR/refresh.mjs"' } }));
  await writeFile(path.join(draft, "refresh.mjs"), "console.log(JSON.stringify({ generatedAt: new Date().toISOString(), errors: 12 }))");
  return "The errors dashboard is ready.";
};
`;

async function signedIn(t: test.TestContext, agent = fakeAgent) {
  const fixture = await nativeUiFixture(t, (root) => {
    const module = path.join(root, "dashboard-agent.mjs");
    writeFileSync(module, agent);
    return { JOINT_BOB_DASHBOARD_AGENT: module };
  });
  const { page, environment, node } = fixture;
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3);
  return fixture;
}

test("a project dashboard is described, previewed, saved and refreshed from dashboard mode", { timeout: 180_000 }, async (t) => {
  const { page } = await signedIn(t);
  await page.locator('[aria-label="Actions for Internal Assistant"]').click();
  await page.getByTestId("project-dashboard-button").click();
  await page.locator("#dashboardDialog[open]").waitFor();
  await page.getByTestId("dashboard-empty").waitFor();
  assert.match(await page.getByTestId("dashboard-title").textContent() ?? "", /Internal Assistant/);

  await page.getByTestId("dashboard-request").fill("Show how many bugs we got today");
  await page.getByTestId("dashboard-create").click();
  await page.getByTestId("dashboard-creator").waitFor();
  await page.getByText("I built a dashboard that shows today's bugs.").waitFor();

  const preview = page.getByTestId("dashboard-draft-frame");
  await preview.waitFor();
  assert.equal(await preview.getAttribute("sandbox"), "allow-scripts", "agent-written pages never get the app's origin");
  // A finished script draft is test-refreshed without being asked, so the preview has real data.
  await page.frameLocator('[data-testid="dashboard-draft-frame"]').getByText("Bugs today").waitFor();
  await page.frameLocator('[data-testid="dashboard-draft-frame"]').getByText("7", { exact: true }).waitFor();
  await page.getByTestId("dashboard-stage-status").filter({ hasText: "Test refresh worked" }).waitFor();

  // The chat is a panel on the left that folds away and comes back.
  const chat = await page.getByTestId("dashboard-chat").boundingBox();
  const stage = await preview.boundingBox();
  assert.ok(chat && stage && chat.x + chat.width <= stage.x, `the chat sits left of the preview: ${JSON.stringify({ chat, stage })}`);
  await page.getByTestId("dashboard-chat-toggle").click();
  await page.getByTestId("dashboard-chat").waitFor({ state: "hidden" });
  const wider = await preview.boundingBox();
  assert.ok(wider && stage && wider.width > stage.width + 200, "the preview takes the room the chat gave up");
  await page.getByTestId("dashboard-chat-open").click();
  await page.getByTestId("dashboard-chat").waitFor();

  await page.getByTestId("dashboard-save").click();
  const live = page.getByTestId("dashboard-frame");
  await live.waitFor();
  assert.equal(await live.getAttribute("sandbox"), "allow-scripts");
  await page.getByTestId("dashboard-refresh").click();
  await page.getByTestId("dashboard-status").filter({ hasText: /Refreshed/ }).waitFor();
  await page.frameLocator('[data-testid="dashboard-frame"]').getByText("7", { exact: true }).waitFor();

  const frameBounds = await live.boundingBox();
  const bodyBounds = await page.getByTestId("dashboard-body").boundingBox();
  assert.ok(frameBounds && bodyBounds && frameBounds.height > bodyBounds.height * 0.9, "saved dashboard fills the modal body even without notices");

  await page.getByTestId("dashboard-share").click();
  await page.getByTestId("dashboard-share-target").selectOption("project");
  await page.getByTestId("dashboard-share-add").click();
  await page.getByTestId("dashboard-share-row").filter({ hasText: "This project" }).waitFor();
  await page.getByTestId("dashboard-share-save").click();
  await page.getByText("Sharing saved").waitFor();
  await page.getByTestId("dashboard-share").click();
  await page.getByTestId("dashboard-share-row").filter({ hasText: "This project" }).waitFor();
  await page.getByTestId("dashboard-share-remove").click();
  assert.equal(await page.getByTestId("dashboard-share-row").count(), 0);
  const workspaceOption = page.getByTestId("dashboard-share-target").locator('option[value^="workspace:"]');
  await page.getByTestId("dashboard-share-target").selectOption((await workspaceOption.first().getAttribute("value"))!);
  await page.getByTestId("dashboard-share-add").click();
  await page.getByTestId("dashboard-share-save").click();
  await page.getByTestId("dashboard-share").click();
  await page.getByTestId("dashboard-share-row").filter({ hasText: "Workspace" }).waitFor();

  await page.getByTestId("dashboard-close").click();
  await page.locator("#dashboardDialog[open]").waitFor({ state: "hidden" });
});

test("workspaces and conversations open their own dashboard mode", { timeout: 180_000 }, async (t) => {
  const { page } = await signedIn(t);
  await page.getByTestId("workspace-dashboard-button").first().click();
  await page.locator("#dashboardDialog[open]").waitFor();
  await page.getByTestId("dashboard-empty").waitFor();
  assert.equal(await page.getByTestId("dashboard-host-project").count(), 1, "a workspace dashboard picks the project it runs in");
  await page.getByTestId("dashboard-close").click();

  await page.locator("#projectList .list-row").first().click();
  await page.locator("#sessionList .list-row").first().click();
  await page.waitForFunction(() => document.querySelector("#sessionTitle")?.textContent !== "Select a conversation");
  await page.getByTestId("chat-dashboard-button").click();
  await page.waitForFunction(() => document.querySelector("#dashboardDialog")?.open || document.querySelector(".toast"));
  const problem = await page.evaluate(() => document.querySelector(".toast .toast-message")?.textContent ?? "");
  assert.equal(problem, "", "opening the conversation dashboard shows no error");
  await page.locator("#dashboardDialog[open]").waitFor();
  await page.getByTestId("dashboard-empty").waitFor();
  assert.match(await page.getByTestId("dashboard-eyebrow").textContent() ?? "", /Conversation dashboard/);
});

async function within(page: import("playwright-core").Page, testid: string, height: number): Promise<void> {
  const box = await page.getByTestId(testid).boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= height, `${testid} must be on screen: ${JSON.stringify(box)}`);
}

test("on a phone, the project sheet and the conversation tools open dashboard mode", { timeout: 180_000 }, async (t) => {
  const { page } = await signedIn(t);
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-focus-ui-toggle").check();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.body.classList.contains("focus-ui"));
  await page.getByTestId("settings-cancel-button").click();

  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("body.view-sessions").waitFor();
  await page.getByTestId("focus-controls-button").click();
  await page.getByTestId("focus-dashboard").click();
  await page.locator("#dashboardDialog[open]").waitFor();
  await page.getByTestId("dashboard-empty").waitFor();
  assert.match(await page.getByTestId("dashboard-eyebrow").textContent() ?? "", /Project dashboard/);
  await page.getByTestId("dashboard-request").fill("Show how many bugs we got today");
  await within(page, "dashboard-create", 844);
  await page.getByTestId("dashboard-create").click();
  await page.getByText("I built a dashboard that shows today's bugs.").waitFor();
  for (const control of ["dashboard-send", "dashboard-close"]) await within(page, control, 844);
  // On a phone the chat slides over the preview and folds away to show it.
  await page.getByTestId("dashboard-chat-toggle").click();
  await page.getByTestId("dashboard-chat").waitFor({ state: "hidden" });
  await page.getByTestId("dashboard-draft-frame").waitFor();
  await within(page, "dashboard-stage-chat", 844);
  for (const control of ["dashboard-test-refresh", "dashboard-save", "dashboard-close"]) await within(page, control, 844);
  await page.getByTestId("dashboard-save").click();
  await page.getByTestId("dashboard-frame").waitFor();
  for (const control of ["dashboard-refresh", "dashboard-edit", "dashboard-close"]) await within(page, control, 844);
  const header = await page.evaluate(() => ({
    close: document.querySelector("#dashboardClose")!.getBoundingClientRect().top,
    title: document.querySelector("#dashboardTitle")!.getBoundingClientRect().top,
  }));
  assert.ok(Math.abs(header.close - header.title) < 24, `the close button stays beside the title: ${JSON.stringify(header)}`);
  await page.getByTestId("dashboard-close").click();

  await page.locator("#sessionList .session-card").first().click();
  await page.locator("body.view-chat").waitFor();
  await page.getByTestId("focus-controls-button").click();
  await page.getByTestId("focus-tools").click();
  await page.getByTestId("chat-more-dashboard-button").click();
  await page.locator("#dashboardDialog[open]").waitFor();
  assert.match(await page.getByTestId("dashboard-eyebrow").textContent() ?? "", /Conversation dashboard/);
});

test("while the agent works, its steps show in the middle, its page appears early, and closing does not stop it", { timeout: 180_000 }, async (t) => {
  const { page } = await signedIn(t, slowAgent);
  await page.locator('[aria-label="Actions for Internal Assistant"]').click();
  await page.getByTestId("project-dashboard-button").click();
  await page.getByTestId("dashboard-request").fill("Show today's errors");
  await page.getByTestId("dashboard-create").click();

  const activity = page.getByTestId("dashboard-activity");
  await activity.waitFor();
  await activity.getByText("psql -c 'select count(*) from errors'").first().waitFor();
  const card = await activity.boundingBox();
  const body = await page.getByTestId("dashboard-body").boundingBox();
  assert.ok(card && body && Math.abs((card.x + card.width / 2) - (body.x + body.width / 2)) < body.width * 0.2, "the progress sits in the middle of the screen");
  await page.getByTestId("dashboard-live-message").getByText("Looking at the errors table").waitFor();
  await page.getByTestId("dashboard-status").getByText("Agent working").waitFor();

  // The page shows while the agent is still working, with the progress over it.
  await page.getByTestId("dashboard-draft-frame").waitFor();
  await page.getByTestId("dashboard-activity-strip").waitFor();
  await page.frameLocator('[data-testid="dashboard-draft-frame"]').getByText("Errors today").waitFor();
  await page.frameLocator('[data-testid="dashboard-draft-frame"]').getByText("12", { exact: true }).waitFor();
  await page.getByText("The errors dashboard is ready.").waitFor();

  // Closing while it works: the work goes on, and the page says when it is done.
  await page.getByTestId("dashboard-message-input").fill("Add errors per day");
  await page.getByTestId("dashboard-send").click();
  await page.getByTestId("dashboard-activity-strip").waitFor();
  await page.getByTestId("dashboard-close").click();
  await page.locator("#dashboardDialog[open]").waitFor({ state: "hidden" });
  await page.getByText("the dashboard agent keeps working").waitFor();
  await page.getByTestId("dashboard-ready-open").click({ timeout: 30_000 });
  await page.locator("#dashboardDialog[open]").waitFor();
  await page.getByTestId("dashboard-creator").waitFor();
  assert.equal(await page.getByTestId("dashboard-live-message").count(), 0, "the finished turn is no longer shown as live");
});

