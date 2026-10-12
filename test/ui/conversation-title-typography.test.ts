import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";

test("labeled conversation titles keep uniform typography in every word", { timeout: 30_000 }, async (t) => {
  const styles = await readFile(new URL("../../public/styles.css", import.meta.url), "utf8");
  // Match sessionCard's title/label nesting without depending on login or a live account.
  const fixture = `<!doctype html><link rel="stylesheet" href="/styles.css">
    <main style="width:315px">
      <button class="session-card"><strong>install for <span class="session-title-tail">ezbob<span class="session-classification session-classification-icon">✨</span></span></strong><span>5 Oct at 15:50</span></button>
      <button class="session-card"><strong>settings <span class="session-title-tail">page<span class="session-classification">Support</span></span></strong><span>12 Oct at 20:44</span></button>
      <button class="session-card"><strong>unlabeled conversation</strong><span>12 Oct at 20:44</span></button>
    </main>`;
  const server = createServer((request, response) => {
    const css = request.url === "/styles.css";
    response.setHeader("Content-Type", css ? "text/css" : "text/html");
    response.end(css ? styles : fixture);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = await launchChrome({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ serviceWorkers: "block" });
  await page.goto(`http://127.0.0.1:${address.port}`);

  for (const theme of ["light", "dark"]) {
    for (const active of [false, true]) {
      await page.evaluate(({ theme, active }) => {
        document.documentElement.dataset.theme = theme;
        document.querySelectorAll(".session-card").forEach((card) => card.classList.toggle("active", active));
      }, { theme, active });
      const titles = await page.locator(".session-title-tail").evaluateAll((tails) => tails.map((tail) => {
        const title = getComputedStyle(tail.closest("strong")!);
        const word = getComputedStyle(tail);
        const properties = ["font-family", "font-size", "font-weight", "line-height", "color"];
        return {
          text: tail.firstChild?.textContent,
          title: properties.map((property) => title.getPropertyValue(property)),
          word: properties.map((property) => word.getPropertyValue(property)),
          whiteSpace: word.whiteSpace,
        };
      }));
      assert.equal(titles.length, 2, "exercise both icon and text labels");
      for (const { text, title, word, whiteSpace } of titles) {
        assert.deepEqual(word, title, `last word "${text}" must match its title in ${theme} theme, active=${active}`);
        assert.equal(whiteSpace, "nowrap", "last word and label still wrap together");
      }
      const sizes = await page.locator(".session-card").evaluateAll((cards) => cards.map((card) => ({
        title: getComputedStyle(card.querySelector("strong")!).fontSize,
        meta: getComputedStyle(card.querySelector(":scope > span")!).fontSize,
        badge: card.querySelector(".session-classification") && getComputedStyle(card.querySelector(".session-classification")!).fontSize,
      })));
      assert.deepEqual(sizes, [
        { title: "13.5px", meta: "11px", badge: "14px" },
        { title: "13.5px", meta: "11px", badge: "11px" },
        { title: "13.5px", meta: "11px", badge: null },
      ], "unlabeled titles, metadata, and badges keep their own sizes");
    }
  }
});
