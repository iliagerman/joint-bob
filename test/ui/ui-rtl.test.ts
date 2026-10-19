import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("markdown renders Hebrew and English blocks in their natural directions", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-rtl-"));
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage();
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();

    const directions = await page.evaluate(async () => {
      const { renderMarkdown } = await import("/markdown.js");
      const host = document.createElement("div");
      host.className = "message-content md";
      document.body.append(host);
      renderMarkdown(host, "# כותרת\n\nשלום עולם\n\nEnglish paragraph\n\nשלום `const x = 1` עולם\n\n- פריט ראשון\n- second item\n\n> ציטוט\n\n```js\nconst answer = 42;\n```\n\n| כותרת | Value |\n| --- | --- |\n| תוכן | text |");
      const paragraphs = [...host.querySelectorAll(":scope > p")];
      const items = [...host.querySelectorAll("li")];
      const cells = [...host.querySelectorAll("th, td")];
      return {
        host: host.dir,
        heading: { dir: host.querySelector("h1")!.dir, computed: getComputedStyle(host.querySelector("h1")!).direction },
        quote: { dir: host.querySelector("blockquote p")!.dir, computed: getComputedStyle(host.querySelector("blockquote p")!).direction },
        inlineCode: { dir: host.querySelector("p code")!.dir, computed: getComputedStyle(host.querySelector("p code")!).direction },
        codeBlock: { dir: host.querySelector(".code-block")!.dir, computed: getComputedStyle(host.querySelector(".code-block pre")!).direction },
        paragraphs: paragraphs.map(element => ({ dir: element.dir, computed: getComputedStyle(element).direction })),
        items: items.map(element => ({ dir: element.dir, computed: getComputedStyle(element).direction })),
        cells: cells.map(element => ({ dir: element.dir, computed: getComputedStyle(element).direction, align: getComputedStyle(element).textAlign })),
      };
    });

    assert.deepEqual(directions.paragraphs, [{ dir: "auto", computed: "rtl" }, { dir: "auto", computed: "ltr" }, { dir: "auto", computed: "rtl" }]);
    assert.deepEqual(directions.quote, { dir: "auto", computed: "rtl" });
    assert.deepEqual(directions.inlineCode, { dir: "ltr", computed: "ltr" });
    assert.deepEqual(directions.codeBlock, { dir: "ltr", computed: "ltr" });
    assert.deepEqual(directions.items, [{ dir: "auto", computed: "rtl" }, { dir: "auto", computed: "ltr" }]);
    assert.deepEqual(directions.heading, { dir: "auto", computed: "rtl" });
    assert.deepEqual(directions.cells, [
      { dir: "auto", computed: "rtl", align: "start" }, { dir: "auto", computed: "ltr", align: "start" },
      { dir: "auto", computed: "rtl", align: "start" }, { dir: "auto", computed: "ltr", align: "start" },
    ]);
    assert.equal(directions.host, "auto");

    // English labels keep the paragraph LTR; embedded Hebrew still reads RTL.
    // Use logical-order text, not the terminal workaround that caused the report.
    const source = "Tenant: fixture\nProject: ז'בוטינסקי 133 תל אביב\nSalesperson: דנה לוי\nSalesperson ID: 27105";
    const mixed = await page.evaluate(async (source) => {
      const { appendMessage, renderBubbleContent } = await import("/app/chat-transcript.js");
      const results = [];
      for (const role of ["user", "assistant"]) {
        const bubble = appendMessage(role, "Tenant: fixture", false);
        renderBubbleContent(bubble, source);
        await new Promise(requestAnimationFrame);
        const paragraph = bubble.querySelector(".message-content p");
        const positions = ["Project:", "ז'בוטינסקי", "133", "תל אביב", "דנה לוי", "27105"].map((token) => {
          const node = [...paragraph.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.includes(token));
          const start = node.textContent.indexOf(token);
          const [first, last] = [start, start + token.length - 1].map((offset) => {
            const range = document.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            const rect = range.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width };
          });
          return { token, first, last };
        });
        results.push({ role, raw: bubble._raw, text: paragraph.innerText, direction: getComputedStyle(paragraph).direction, positions });
      }
      return results;
    }, source);
    for (const message of mixed) {
      assert.equal(message.raw, source, `${message.role}: copy keeps logical-order text`);
      assert.equal(message.text, source, `${message.role}: rendering keeps letters and word order`);
      assert.equal(message.direction, "ltr", `${message.role}: English labels anchor the lines`);
      for (const { token, first, last } of message.positions) {
        assert.ok(first.width > 0 && last.width > 0, `${message.role}: ${token} is rendered`);
        assert.equal(first.y, last.y, `${message.role}: ${token} stays on one line`);
        assert.ok(/[\u0590-\u05ff]/.test(token) ? first.x > last.x : first.x < last.x,
          `${message.role}: ${token} must read in its natural direction: ${JSON.stringify({ first, last })}`);
      }
    }
  } finally {
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
