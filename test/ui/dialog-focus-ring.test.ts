import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";

test("a keyboard-opened dialog draws no square focus frame around its rounded card", { timeout: 30_000 }, async (t) => {
  const styles = await readFile(new URL("../../public/styles.css", import.meta.url), "utf8");
  // Same shape as the background tasks dialog: a <dialog> box holding a rounded .dialog-card.
  const fixture = `<!doctype html><link rel="stylesheet" href="/styles.css">
    <button id="open" type="button" onclick="document.getElementById('dialog').showModal()">Open</button>
    <dialog id="dialog"><section class="dialog-card"><p>No running tasks</p><button id="close" type="button">Close</button></section></dialog>`;
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

  await page.focus("#open");
  await page.keyboard.press("Enter");
  // Clicking the card's empty space hands focus to the dialog box itself.
  await page.locator("#dialog p").click();
  await page.keyboard.press("Shift");
  const dialog = await page.evaluate(() => {
    const element = document.getElementById("dialog")!;
    return { open: element.open, focusVisible: element.matches(":focus-visible"), outline: getComputedStyle(element).outlineStyle };
  });
  assert.equal(dialog.open, true);
  assert.equal(dialog.focusVisible, true, "exercise the focused <dialog> box, not one of its controls");
  assert.equal(dialog.outline, "none");

  await page.keyboard.press("Tab");
  const control = await page.evaluate(() => ({
    id: document.activeElement?.id,
    outline: getComputedStyle(document.activeElement!).outlineStyle,
  }));
  assert.deepEqual(control, { id: "close", outline: "solid" }, "controls inside the dialog keep their focus ring");
});
