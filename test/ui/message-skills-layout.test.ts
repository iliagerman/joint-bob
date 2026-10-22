import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function renderSkills(page: Page, names: string[]): Promise<void> {
  await page.evaluate(async (skills) => {
    const transcript = await import("/app/chat-transcript.js");
    transcript.clearChat();
    transcript.appendMessage("user", "Check the changes", false);
    for (const [index, skill] of skills.entries()) {
      const tool = transcript.appendToolMessage("read", `skill-${index}`, 0, 0, { skill });
      transcript.updateToolMessage(tool, "Skill instructions", "Done", false, 1);
    }
    transcript.appendMessage("assistant", "Changes checked.", false, [], true, {
      harnessId: "pi", provider: "openai-codex", modelId: "gpt-6.1-sol", reasoning: "medium",
    });
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, names);
}

async function assertSkillsFit(page: Page, names: string[]): Promise<void> {
  const chip = page.getByTestId("message-skills");
  assert.equal(await chip.count(), 1);
  assert.equal(await chip.getAttribute("aria-label"), `Skill${names.length === 1 ? "" : "s"} used in this turn: ${names.join(", ")}`);
  const layout = await chip.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textRects = [];
    while (walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      textRects.push(...Array.from(range.getClientRects(), (box) => box.toJSON()));
    }
    return {
      chip: element.getBoundingClientRect().toJSON(), row: element.parentElement.getBoundingClientRect().toJSON(),
      controls: [...element.parentElement.children].map((node) => node.getBoundingClientRect().toJSON()), textRects,
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
    };
  });
  assert.ok(layout.chip.width > 0 && layout.chip.height > 0, "skill badge is visible");
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `skill text clipped horizontally: ${JSON.stringify(layout)}`);
  assert.ok(layout.scrollHeight <= layout.clientHeight + 1, `skill text clipped vertically: ${JSON.stringify(layout)}`);
  for (const box of layout.textRects) {
    assert.ok(box.left >= layout.chip.left && box.right <= layout.chip.right + 1
      && box.top >= layout.chip.top && box.bottom <= layout.chip.bottom + 1,
    `skill text outside badge: ${JSON.stringify({ chip: layout.chip, box })}`);
  }
  for (const box of layout.controls) {
    assert.ok(box.left >= layout.row.left && box.right <= layout.row.right + 1
      && box.top >= layout.row.top && box.bottom <= layout.row.bottom + 1,
    `message control outside action row: ${JSON.stringify({ row: layout.row, box })}`);
  }
}

test("answer skill badges stay readable beside a long model label", async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const session = await signIn(environment, node);
  const [name, value] = session.cookie.split("=");
  await page.context().addCookies([{ name, value, url: node.url }]);
  await page.goto(node.url);
  await page.getByText("Internal Assistant", { exact: true }).click();
  await page.locator(".session-card").first().click();
  await page.locator("#chatPanel").waitFor({ state: "visible" });
  await page.locator("#messages .message.assistant").first().waitFor();

  const cases = [
    { label: "one skill", names: ["push-code"] },
    { label: "several skills", names: ["systematic-debugging", "test-driven-development", "verification-before-completion", "push-code"] },
    { label: "an unbroken long name", names: ["a".repeat(90)] },
  ];
  for (const width of [320, 393, 768, 1440]) {
    for (const { label, names } of cases) {
      await t.test(`${label} at ${width}px`, async () => {
        await page.setViewportSize({ width, height: 900 });
        await renderSkills(page, names);
        await assertSkillsFit(page, names);
      });
    }
  }
});
