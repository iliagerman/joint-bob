import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";

const css = await readFile(new URL("../../public/styles.css", import.meta.url), "utf8");

test("project badges stay together and abbreviate in a narrow card", async () => {
  const browser = await launchChrome({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>${css}</style><button class="project-card" style="width: 260px"><div class="project-card-heading"><strong>Dak-Live</strong><span class="project-card-badges"><em class="project-running-badge"><span class="project-badge-count">1</span><span class="project-badge-label"> running</span></em><em class="project-review-badge"><span class="project-badge-count">1</span><span class="project-badge-label"> to review</span></em></span></div></button><div class="status-pill live">Connected</div>`);
    const badges = page.locator(".project-card-badges");
    assert.equal(await badges.locator("em").count(), 2);
    assert.equal(await page.locator(".project-badge-label").first().evaluate((element) => getComputedStyle(element).display), "none");
    const positions = await badges.locator("em").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().top));
    assert.equal(positions[0], positions[1]);
    assert.equal(await page.locator(".status-pill.live").evaluate((element) => getComputedStyle(element).animationName), "none");
    await page.locator(".status-pill").evaluate((element) => element.classList.add("working"));
    assert.equal(await page.locator(".status-pill.working").evaluate((element) => getComputedStyle(element).animationName), "dot-breathe");
    await page.locator(".project-card").evaluate((element) => (element as HTMLElement).style.width = "400px");
    assert.notEqual(await page.locator(".project-badge-label").first().evaluate((element) => getComputedStyle(element).display), "none");
  } finally {
    await browser.close();
  }
});
