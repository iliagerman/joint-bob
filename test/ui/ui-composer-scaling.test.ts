import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("the composer fits empty and wrapped text when appearance size changes", { timeout: 120_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
  const input = page.getByTestId("chat-message-input");
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);

  const overflows: string[] = [];
  async function checkFits(label: string) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const size = await input.evaluate(el => ({
      height: el.clientHeight, contentHeight: el.scrollHeight,
      width: el.clientWidth, contentWidth: el.scrollWidth,
      inlineHeight: el.style.height, zoom: getComputedStyle(document.querySelector("#chatPanel")!).zoom,
    }));
    if (size.contentHeight > size.height + 1 || size.contentWidth > size.width + 1) {
      overflows.push(`${label}: ${JSON.stringify(size)}`);
    }
    return size;
  }

  async function preset(name: string) {
    await page.getByTestId("appearance-open").click();
    await page.getByTestId(`appearance-preset-${name}`).click();
    await page.getByTestId("appearance-close-button").click();
  }

  for (const name of ["large", "larger", "huge", "default"]) {
    await preset(name);
    await checkFits(`empty at ${name}`);
  }
  const draft = "A draft that must stay readable while increasing the conversation font size. ".repeat(3);
  await input.fill(draft);
  const normal = await checkFits("draft at default");
  await preset("huge");
  const enlarged = await checkFits("existing draft at huge");
  assert.ok(enlarged.height > normal.height, "the input grows when the existing draft wraps onto more lines");
  assert.equal(await input.inputValue(), draft);
  await page.getByTestId("appearance-open").click();
  await page.getByTestId("appearance-chat-slider").fill("1.2");
  await page.getByTestId("appearance-close-button").click();
  await checkFits("existing draft with custom conversation size");
  await preset("default");
  const reduced = await checkFits("draft back at default");
  assert.ok(reduced.height < enlarged.height, "the input shrinks when the size is reduced");

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await input.fill("Long draft line\n".repeat(40));
    const long = await input.evaluate(el => ({
      height: el.clientHeight, contentHeight: el.scrollHeight,
      overflowX: getComputedStyle(el).overflowX, overflowY: getComputedStyle(el).overflowY,
    }));
    assert.ok(long.contentHeight > long.height, "a long draft must still scroll vertically");
    assert.ok(long.height <= (viewport.width < 1024 ? 160 : 360), "the input keeps its height cap");
    assert.equal(long.overflowY, "auto");
    assert.equal(long.overflowX, "hidden");
    await input.fill("A short draft");
    await checkFits(`short draft at width ${viewport.width}`);
    await input.fill("");
    await checkFits(`cleared at width ${viewport.width}`);
  }
  assert.deepEqual(overflows, [], "text should fit without scrollbars after a font-size change");
  assert.deepEqual(errors, [], "resizing does not cause browser errors or observer loops");
});
