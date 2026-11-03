import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";

test("activity header uses accessible icons in narrow panels and labels in wide panels", async () => {
  const html = await readFile("public/index.html", "utf8");
  const css = await readFile("public/styles.css", "utf8");
  const header = html.match(/<header class="activity-panel-header">[\s\S]*?<\/header>/)![0];
  const browser = await launchChrome({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // Only the real header markup and stylesheet. No app, accounts or remote resources.
    await page.route("**/*", route => route.abort());
    await page.setContent(`<style>${css}</style><aside class="activity-panel" style="width:380px">${header}</aside>`);
    for (const width of [280, 320, 380, 460, 380]) {
      await page.locator(".activity-panel").evaluate((panel, width) => { panel.style.width = `${width}px`; }, width);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const labels = page.locator(".activity-tabs button > span, .activity-mode > span");
      assert.equal(await labels.count(), 4);
      for (const label of await labels.all()) {
        assert.equal(await label.isVisible(), width > 400, `${width}px panel: label visibility must follow panel width, not viewport width`);
      }
      const buttons = page.locator(".activity-panel-header button");
      const boxes = await buttons.evaluateAll(buttons => buttons.map(button => {
        const box = button.getBoundingClientRect();
        const panel = button.closest(".activity-panel")!.getBoundingClientRect();
        return { left: box.left, right: box.right, panelRight: panel.right, iconWidth: button.querySelector("svg")!.getBoundingClientRect().width };
      }));
      assert.equal(boxes.length, 5);
      for (const [index, box] of boxes.entries()) {
        assert.ok(box.iconWidth > 0, `${width}px: every icon stays visible`);
        assert.ok(box.right <= box.panelRight + 1, `${width}px: control stays inside panel`);
        if (index) assert.ok(box.left >= boxes[index - 1].right, `${width}px: controls must not overlap`);
      }
      for (const name of ["Activity", "Chat", "Story", "Activity overview", "Collapse activity"]) {
        const control = page.getByRole(name === "Activity" || name === "Chat" ? "tab" : "button", { name, exact: true });
        assert.equal(await control.count(), 1, `${width}px: accessible name ${name} remains available`);
        assert.ok(await control.getAttribute("title"), `${width}px: ${name} has a hover title`);
      }
    }
  } finally {
    await browser.close();
  }
});
