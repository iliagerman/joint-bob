// Browser sanity suite: drives a real Chrome against a seeded dev node and walks
// the journey a person walks — sign in, pick a project, open a conversation, open
// the canvas picker. It exists to catch breakage that source-text assertions
// cannot see: a login that never persists its session, a panel that renders
// nothing, or rows collapsed to an unreadable height.
//
// Run with `npm run test:ui`. It is deliberately outside the `test/*.test.ts`
// glob: it needs a Chrome binary, and a suite that silently skips itself would
// report success while testing nothing.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
const failedResponses: string[] = [];

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);

  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: process.env.HEADED !== "1" });
  context = await browser.newContext({
    // Wide enough for the desktop layout: the canvas is hidden below 1024px.
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    // The app ships a service worker. Blocking it keeps a cached shell from a
    // previous run out of the picture.
    serviceWorkers: "block",
  });
  page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
}, { timeout: 120_000 });

after(async () => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, "final.png") }).catch(() => undefined);
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("signing in through the login form reaches the app and the session survives a reload", async () => {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });

  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();

  // Readiness is a rendered project, not a load event: the shell paints long
  // before the project list arrives.
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 20_000 });
  assert.equal(await page.locator("#loginDialog[open]").count(), 0, "login dialog closes");

  // A dropped session cookie still closes the dialog, so the reload is the real
  // check that signing in persisted.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 20_000 });
  assert.equal(await page.locator("#loginDialog[open]").count(), 0, "reload stays signed in");
});

test("the project list shows every seeded project", async () => {
  for (const project of node.projects) {
    await page.locator(".project-card", { hasText: project.name }).first().waitFor({ timeout: 15_000 });
  }
});

test("opening a conversation renders its transcript", async () => {
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();

  const message = page.locator(".message").first();
  await message.waitFor({ timeout: 20_000 });
  assert.ok((await page.locator(".message").count()) >= 2, "both turns of the conversation render");
  assert.match(await message.innerText(), /re-threading the same builder prompt/);
});

test("conversation rows identify the harness with only its icon", async () => {
  const conversation = page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first();
  const agent = conversation.getByTestId("session-agent-label");

  assert.equal(await agent.getByTestId("session-agent-icon").count(), 1, "conversation shows one harness icon");
  assert.equal(await agent.innerText(), "", "conversation does not repeat the harness name");
  assert.equal(await agent.getAttribute("aria-label"), "Pi", "the icon keeps an accessible harness name");
});

test("the selected project and conversation stay highlighted in their sidebars", async () => {
  const project = page.locator(".project-card", { hasText: "Internal Assistant" }).first();
  const conversation = page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first();

  assert.equal(await project.getAttribute("aria-current"), "true", "selected project is announced as current");
  assert.equal(await conversation.getAttribute("aria-current"), "true", "selected conversation is announced as current");

  for (const [label, row] of [["project", project], ["conversation", conversation]] as const) {
    const border = await row.evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.borderTopColor, width: style.borderTopWidth };
    });
    assert.notEqual(border.width, "0px", `selected ${label} has a border`);
    assert.notEqual(border.color, "rgba(0, 0, 0, 0)", `selected ${label} border is visible`);
  }
});

// The toolbar's overflow actions live in a <details> that desktop flattens into
// the row with `display: contents`. Current browsers hide a closed <details>'s
// content through `::details-content`, which made Terminal, Notify, Rename
// and Safeguards vanish on wide screens while still occupying
// layout. Only a real browser sees that.
test("the chat toolbar actions are visible on a wide screen and fold into the menu on a phone", async () => {
  const ids = ["chat-open-terminal-button", "chat-notify-button", "chat-rename-button", "chat-safeguards-button"];
  for (const id of ids) {
    assert.equal(await page.getByTestId(id).isVisible(), true, `${id} is visible in the desktop toolbar`);
  }
  assert.equal(await page.getByTestId("chat-more-button").isVisible(), false, "the overflow summary stays hidden on desktop");

  await page.setViewportSize({ width: 430, height: 900 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByTestId("chat-open-terminal-button").isVisible(), false, "the actions fold away on a phone");
  assert.equal(await page.getByTestId("chat-more-button").isVisible(), true, "the overflow summary appears on a phone");

  await page.getByTestId("chat-more-button").click();
  for (const id of ids) {
    assert.equal(await page.getByTestId(id).isVisible(), true, `${id} is visible once the menu is open`);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
});

test("a phone reloads conversations missed while its watch socket was disconnected", async () => {
  const mobileContext = await browser.newContext({
    viewport: { width: 430, height: 900 },
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  await mobileContext.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL) {
        super(url);
        if (String(url).includes("sessionPath=watch")) (window as typeof window & { testWatchSocket: WebSocket }).testWatchSocket = this;
      }
    };
  });
  const mobilePage = await mobileContext.newPage();
  const sessionId = randomUUID();
  const title = "Conversation created while phone slept";
  const project = node.projects.find((candidate) => candidate.name === "Infra Scripts")!;

  try {
    await mobilePage.goto(node.url, { waitUntil: "domcontentloaded" });
    await mobilePage.getByTestId("login-username-input").fill(environment.username);
    await mobilePage.getByTestId("login-password-input").fill(environment.password);
    await mobilePage.getByTestId("login-submit-button").click();
    await mobilePage.locator(".project-card", { hasText: project.name }).first().waitFor({ state: "attached" });
    await mobilePage.getByTestId("session-list-loading-bar").waitFor({ state: "hidden" });
    await mobilePage.getByTestId("nav-projects-button").click();
    await mobilePage.locator("body.view-projects #projectsPanel").waitFor();
    await mobilePage.locator(".project-card", { hasText: project.name }).first().click();
    await mobilePage.locator("#chatsLiveDot").waitFor({ state: "visible" });
    await mobilePage.evaluate(() => (window as typeof window & { testWatchSocket: WebSocket }).testWatchSocket.close());
    await mobilePage.locator("#chatsLiveDot").waitFor({ state: "hidden" });

    const now = new Date().toISOString();
    const database = new DatabaseSync(path.join(node.dataDir, "node.db"));
    database.prepare("INSERT INTO conversation_records (project_id, engine, session_id, created_at, updated_at, origin_node_id) VALUES (?, 'claude', ?, ?, ?, ?)")
      .run(project.id, sessionId, now, now, node.nodeId);
    database.prepare("INSERT INTO name_overrides (scope, key, name, updated_at, origin_node_id) VALUES ('sessions', ?, ?, ?, ?)")
      .run(sessionId, title, now, node.nodeId);
    database.close();

    assert.equal(await mobilePage.locator(".session-card", { hasText: title }).count(), 0, "the disconnected phone has stale conversations");
    await mobilePage.locator("#chatsLiveDot").waitFor({ state: "visible", timeout: 10_000 });
    await mobilePage.locator(".session-card", { hasText: title }).waitFor({ timeout: 10_000 });
  } finally {
    await mobileContext.close();
    const database = new DatabaseSync(path.join(node.dataDir, "node.db"));
    database.prepare("DELETE FROM conversation_records WHERE project_id = ? AND engine = 'claude' AND session_id = ?").run(project.id, sessionId);
    database.prepare("DELETE FROM name_overrides WHERE scope = 'sessions' AND key = ?").run(sessionId);
    database.close();
  }
});

test("the canvas picker lists conversations at a readable height", async () => {
  await page.getByTestId("projects-open-canvas-button").click();
  await page.getByTestId("canvas-add-button").click();
  await page.locator(".canvas-session-option").first().waitFor({ timeout: 20_000 });

  // The project with the most conversations, because the rows only used to
  // collapse once the list overflowed its own maximum height.
  await page.selectOption("#canvasProjectSelect", { label: "Internal Assistant" });
  await page.locator(".canvas-session-option", { hasText: "Thread-Based Agent Builder" }).waitFor({ timeout: 20_000 });

  // Two frames, so the measurements below read settled layout.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const overflowing = await page.evaluate(() => {
    const list = document.querySelector(".canvas-session-options");
    return list ? list.scrollHeight > list.clientHeight + 1 : false;
  });
  assert.ok(overflowing, "the list overflows its maximum height, which is the state that used to collapse the rows");

  const rows = await page.evaluate(() => [...document.querySelectorAll(".canvas-session-option")].map((option) => ({
    title: option.querySelector("strong")?.textContent ?? "",
    height: Math.round(option.getBoundingClientRect().height),
    subtitle: option.querySelector("span")?.textContent ?? "",
    subtitleHeight: Math.round(option.querySelector("span")?.getBoundingClientRect().height ?? 0),
    lineHeight: Math.round(parseFloat(getComputedStyle(option.querySelector("span") ?? option).lineHeight)),
  })));

  assert.ok(rows.length >= 3, `picker lists conversations (got ${rows.length})`);
  for (const row of rows) {
    // 44px is the row's minimum height. A row stuck at the minimum is the
    // regression this test exists for: the preview text is clipped mid-line.
    assert.ok(row.height > 44, `row "${row.title}" is taller than its 44px floor (got ${row.height})`);
    assert.ok(
      row.subtitleHeight >= row.lineHeight,
      `row "${row.title}" shows at least one full preview line (got ${row.subtitleHeight} for a ${row.lineHeight}px line)`,
    );
  }

  // The seeded long preview is the one that has to wrap to two lines.
  const wrapping = rows.find((row) => row.subtitle.length > 120);
  assert.ok(wrapping, "a long preview is present to test wrapping");
  assert.ok(
    wrapping.subtitleHeight >= wrapping.lineHeight * 2,
    `a long preview wraps to two lines (got ${wrapping.subtitleHeight} for a ${wrapping.lineHeight}px line)`,
  );
});

test("canvas panes resize in both directions and the canvas scrolls", async () => {
  await page.getByTestId("canvas-picker-cancel-button").click();

  const addConversation = async (title: string, position: "right" | "below") => {
    await page.getByTestId("canvas-add-button").click();
    await page.selectOption("#canvasProjectSelect", { label: "Internal Assistant" });
    await page.selectOption("#canvasSplitPosition", position);
    const option = page.locator(".canvas-session-option", { hasText: title });
    await option.waitFor({ timeout: 20_000 });
    await option.click();
  };

  await addConversation("Thread-Based Agent Builder", "right");
  await addConversation("Mobile Multi-Agent Threads", "right");
  await addConversation("Flow Runner Tool Evaluation", "below");
  await page.locator(".canvas-pane").nth(2).waitFor({ timeout: 20_000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const widthHandle = page.locator('[data-testid="canvas-pane-width-handle"]:not([hidden])').first();
  assert.equal(await widthHandle.getAttribute("role"), "separator");
  assert.equal(await widthHandle.getAttribute("aria-orientation"), "vertical");
  const before = await page.locator(".canvas-pane").first().boundingBox();
  const widthBox = await widthHandle.boundingBox();
  assert.ok(before && widthBox);
  await page.mouse.move(widthBox.x + widthBox.width / 2, widthBox.y + widthBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(widthBox.x + widthBox.width / 2 + 80, widthBox.y + widthBox.height / 2);
  await page.mouse.up();
  const afterWidth = await page.locator(".canvas-pane").first().boundingBox();
  assert.ok(afterWidth && afterWidth.width > before.width, `the left pane grows (from ${before.width}px to ${afterWidth?.width}px)`);

  const heightHandle = page.getByTestId("canvas-row-height-handle").first();
  assert.equal(await heightHandle.getAttribute("role"), "separator");
  assert.equal(await heightHandle.getAttribute("aria-orientation"), "horizontal");
  const beforeHeight = await page.locator(".canvas-pane").first().boundingBox();
  const heightBox = await heightHandle.boundingBox();
  assert.ok(beforeHeight && heightBox);
  await page.mouse.move(heightBox.x + heightBox.width / 2, heightBox.y + heightBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(heightBox.x + heightBox.width / 2, heightBox.y + heightBox.height / 2 + 80);
  await page.mouse.up();
  const afterHeight = await page.locator(".canvas-pane").first().boundingBox();
  assert.ok(afterHeight && afterHeight.height > beforeHeight.height,
    `the row grows (from ${beforeHeight.height}px to ${afterHeight?.height}px)`);
  await heightHandle.focus();
  for (let press = 0; press < 9; press += 1) await page.keyboard.press("ArrowDown");

  const scrolling = await page.evaluate(() => {
    const canvas = document.querySelector("#canvasRoot");
    if (!canvas) return { overflows: false, scrollTop: 0 };
    const overflows = canvas.scrollHeight > canvas.clientHeight + 1;
    canvas.scrollTop = canvas.scrollHeight;
    return { overflows, scrollTop: canvas.scrollTop };
  });
  assert.equal(scrolling.overflows, true, "taller rows make the canvas scroll instead of shrinking panes");
  assert.ok(scrolling.scrollTop > 0, `the canvas can scroll vertically (got ${scrolling.scrollTop})`);
});

test("a markdown file opens as raw source and previews beside it", async () => {
  // A fresh load, because the previous test left the canvas picker open. The dialog is
  // then reached the way a person reaches it: a file mentioned in a conversation.
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().waitFor({ timeout: 20_000 });
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
  await page.getByTestId("chat-file-link").first().click();

  await page.locator("#fileActionDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("file-action-edit-button").click();
  await page.locator("#fileEditorView:not([hidden])").waitFor({ timeout: 20_000 });

  // Raw is the default: the heading marker is in the buffer and the gutter numbers lines.
  const source = await page.locator("#fileEditorView .CodeMirror").first().innerText();
  assert.match(source, /#\s*Internal Assistant/, `the editor shows the raw heading marker (got ${JSON.stringify(source.slice(0, 80))})`);
  const gutter = await page.evaluate(() => {
    const gutters = document.querySelector("#fileEditorView .CodeMirror-gutters");
    return gutters ? Math.round(gutters.getBoundingClientRect().width) : 0;
  });
  assert.ok(gutter > 0, `the line-number gutter is visible while editing (got ${gutter}px)`);
  assert.equal(await page.getByTestId("file-editor-preview").isVisible(), false, "preview stays closed until it is asked for");

  await page.getByTestId("file-editor-preview-button").click();
  const heading = page.locator('[data-testid="file-editor-preview"] h1');
  await heading.waitFor({ timeout: 10_000 });
  assert.equal((await heading.innerText()).trim(), "Internal Assistant", "the preview renders the heading as a heading");

  // Side by side, not stacked: the preview starts to the right of the editor.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const boxes = await page.evaluate(() => {
    const editor = document.querySelector("#fileEditorView .CodeMirror").getBoundingClientRect();
    const preview = document.querySelector("#fileEditorPreview").getBoundingClientRect();
    return { editorRight: Math.round(editor.right), previewLeft: Math.round(preview.left), previewWidth: Math.round(preview.width) };
  });
  assert.ok(boxes.previewLeft >= boxes.editorRight, `preview sits beside the editor (editor ends at ${boxes.editorRight}, preview starts at ${boxes.previewLeft})`);
  assert.ok(boxes.previewWidth > 300, `preview is wide enough to read (got ${boxes.previewWidth})`);

  await page.getByTestId("file-editor-cancel-button").click();
});

test("the View link renders a markdown file as a document", async () => {
  const project = node.projects.find((candidate) => candidate.name === "Internal Assistant");
  assert.ok(project, "the seeded project is present");
  await page.goto(`${node.url}/api/projects/${project.id}/file?path=README.md`, { waitUntil: "domcontentloaded" });

  const heading = page.locator('[data-testid="file-view-markdown"] h1');
  await heading.waitFor({ timeout: 20_000 });
  assert.equal((await heading.innerText()).trim(), "Internal Assistant", "the page renders the heading as a heading, not as '# Internal Assistant'");

  // The bug this covers: the document rendered in a column as narrow as the author's
  // hard wrap, marooned on the left of a wide window.
  const layout = await page.evaluate(() => {
    const body = document.querySelector('[data-testid="file-view-markdown"]').getBoundingClientRect();
    return { left: Math.round(body.left), width: Math.round(body.width), viewport: window.innerWidth };
  });
  assert.ok(layout.width > 500, `the document uses the page width (got ${layout.width} of ${layout.viewport})`);
  assert.ok(layout.left > 100, `the document is centred, not pinned to the left edge (starts at ${layout.left})`);
});


/** WCAG contrast of `text` over `selection` over `surface`, from CSS colour strings.
 * Each layer is composited onto the one below so partial transparency is honoured. */
function contrastRatio(text: string, selection: string, surface: string): number {
  const parse = (value: string): number[] => {
    const parts = value.match(/[\d.]+/g)!.map(Number);
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  };
  const over = (top: number[], bottom: number[]): number[] =>
    [0, 1, 2].map((index) => top[index] * top[3] + bottom[index] * (1 - top[3])).concat(1);
  const luminance = (colour: number[]): number => {
    const channels = colour.slice(0, 3).map((value) => value / 255)
      .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const background = over(parse(selection), parse(surface));
  const [bright, dark] = [luminance(over(parse(text), background)), luminance(background)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}

// The bug this covers: CodeMirror ships a pale lavender selection colour, and the
// editor's surface is always dark. Selected text was near-white on near-white.
test("selected text in the editor stays readable", async () => {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().waitFor({ timeout: 20_000 });
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
  await page.getByTestId("chat-file-link").first().click();
  await page.locator("#fileActionDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("file-action-edit-button").click();
  await page.locator("#fileEditorView:not([hidden])").waitFor({ timeout: 20_000 });

  // Select the first line with the editor focused, so it draws its focused selection
  // colour rather than the idle one. Driven through the editor's own API because the
  // colour is what is under test, not vim's key handling.
  await page.locator("#fileEditorView .CodeMirror-scroll").click();
  await page.evaluate(() => {
    const editor = (document.querySelector("#fileEditorView .CodeMirror") as HTMLElement & { CodeMirror: { focus(): void; setSelection(a: unknown, b: unknown): void } }).CodeMirror;
    editor.focus();
    editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 8 });
  });
  await page.locator("#fileEditorView .CodeMirror-selected").first().waitFor({ timeout: 10_000 });

  // The colours are read in the page and the contrast is worked out here: a helper
  // declared inside page.evaluate does not survive the test runner's transform.
  const painted = await page.evaluate(() => ({
    surface: getComputedStyle(document.querySelector("#fileEditorView .CodeMirror")!).backgroundColor,
    selection: getComputedStyle(document.querySelector("#fileEditorView .CodeMirror-selected")!).backgroundColor,
    text: getComputedStyle(document.querySelector("#fileEditorView .CodeMirror-line")!).color,
  }));
  const ratio = contrastRatio(painted.text, painted.selection, painted.surface);
  assert.ok(ratio >= 4.5,
    `selected text must stay legible (contrast ${ratio.toFixed(2)}:1 for ${painted.text} on ${painted.selection})`);

  await page.keyboard.press("Escape");
  await page.getByTestId("file-editor-cancel-button").click();
});

test("the View link renders a source file as themed, highlighted code", async () => {
  const project = node.projects.find((candidate) => candidate.name === "Internal Assistant");
  assert.ok(project, "the seeded project is present");
  await page.goto(`${node.url}/api/projects/${project.id}/file?path=config.ts`, { waitUntil: "domcontentloaded" });

  const block = page.locator('[data-testid="file-view-markdown"] .code-block');
  await block.waitFor({ timeout: 20_000 });
  assert.match(await block.innerText(), /export const name/, "the page shows the file's source");
  assert.equal((await page.locator('[data-testid="file-view-markdown"] .code-lang').innerText()).trim().toLowerCase(), "typescript",
    "the block names the language it is showing");

  // The bug this covers: a source file arrived as browser-default plain text, ignoring
  // the app's theme entirely.
  const painted = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    page: getComputedStyle(document.body).backgroundColor,
    code: getComputedStyle(document.querySelector(".code-block pre")!).backgroundColor,
    width: Math.round(document.querySelector('[data-testid="file-view-markdown"]')!.getBoundingClientRect().width),
  }));
  assert.ok(["dark", "light"].includes(painted.theme!), `the page adopts a theme (got ${painted.theme})`);
  assert.notEqual(painted.page, "rgba(0, 0, 0, 0)", "the page paints the app's own background");
  assert.notEqual(painted.code, painted.page, "the code block is a distinct surface, not bare text");
  assert.ok(painted.width > 500, `the source uses the page width (got ${painted.width})`);
});

test("a top toast stays above the mobile composer", async () => {
  const mobileContext = await browser.newContext({ viewport: { width: 430, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const mobilePage = await mobileContext.newPage();
  try {
    await mobilePage.goto(node.url, { waitUntil: "domcontentloaded" });
    await mobilePage.getByTestId("login-username-input").fill(environment.username);
    await mobilePage.getByTestId("login-password-input").fill(environment.password);
    await mobilePage.getByTestId("login-submit-button").click();
    await mobilePage.getByTestId("nav-projects-button").click();
    const project = mobilePage.locator(".project-card", { hasText: "Internal Assistant" }).first();
    await project.waitFor({ timeout: 20_000 });
    await project.click();
    await mobilePage.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
    await mobilePage.locator("#messageInput").waitFor();
    await mobilePage.evaluate(() => {
      const toast = document.createElement("div");
      toast.className = "toast";
      toast.innerHTML = '<span class="toast-message">Representative toast</span>';
      document.body.append(toast);
    });
    await mobilePage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layout = await mobilePage.evaluate(() => {
      const toast = document.querySelector(".toast")!.getBoundingClientRect();
      const composer = document.querySelector("#messageInput")!.getBoundingClientRect();
      return { top: toast.top, bottom: toast.bottom, composerTop: composer.top, viewport: window.innerHeight };
    });
    assert.ok(layout.top >= 0 && layout.top < layout.viewport / 4, `toast is in the safe top region (top ${layout.top})`);
    assert.ok(layout.bottom < layout.composerTop, `toast clears composer (${layout.bottom} < ${layout.composerTop})`);
  } finally {
    await mobileContext.close();
  }
});

test("the journey produced no console errors and no failed requests", () => {
  assert.deepEqual(consoleErrors, [], "no console errors");
  assert.deepEqual(failedResponses, [], "no 4xx or 5xx responses");
});
