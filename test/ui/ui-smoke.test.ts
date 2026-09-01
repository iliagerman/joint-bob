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

test("the journey produced no console errors and no failed requests", () => {
  assert.deepEqual(consoleErrors, [], "no console errors");
  assert.deepEqual(failedResponses, [], "no 4xx or 5xx responses");
});
