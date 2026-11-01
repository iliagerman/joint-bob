import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";

test("webhook loading stays centered without moving page content", async () => {
  const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../../public/styles.css", import.meta.url), "utf8");
  const panel = html.slice(html.indexOf('<section class="settings-panel relay-panel" id="settingsPanel-webhooks"'), html.indexOf('<section class="webhooks-view" id="webhooksForm"'));
  const browser = await launchChrome({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>${styles}</style><div class="dialog-card" style="height: 700px">${panel}</section></div>`);
    await page.locator("#settingsPanel-webhooks").evaluate(element => { element.removeAttribute("hidden"); });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const before = await page.locator("#webhooksList").boundingBox();
      await page.locator("#webhooksStatus").evaluate(element => {
        element.textContent = "Opening webhook…";
        (element as HTMLElement).dataset.state = "info";
      });
      const during = await page.locator("#webhooksList").boundingBox();
      assert.deepEqual(during, before, "loading must not move or resize the list");
      const status = (await page.locator("#webhooksStatus").boundingBox())!;
      const bounds = (await page.locator("#settingsPanel-webhooks").boundingBox())!;
      assert.ok(Math.abs(status.x + status.width / 2 - bounds.x - bounds.width / 2) < 2, "loading is horizontally centered");
      assert.ok(Math.abs(status.y + status.height / 2 - bounds.y - bounds.height / 2) < 2, "loading is vertically centered");
      await page.locator("#webhooksStatus").evaluate(element => { element.textContent = ""; });
      assert.deepEqual(await page.locator("#webhooksList").boundingBox(), before, "finishing loading must not move the list");
    }
  } finally { await browser.close(); }
});
