import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("the project overview shows one project's conversations, changes and knowledge, and starts a question or a task for it", async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);

  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-tab-overview").click();
  const picker = page.getByTestId("control-overview-project");
  await picker.waitFor();
  await picker.selectOption({ label: "Internal Assistant" });
  await page.getByTestId("control-overview-conversation").first().waitFor();
  assert.ok(await page.getByTestId("control-overview-conversation").count() >= 1, "the project's conversations are listed");
  assert.equal(await page.getByTestId("control-overview-changes").count(), 1);
  assert.equal(await page.getByTestId("control-overview-knowledge").count(), 1);

  // Both buttons point Bob's chat at this project.
  await page.getByTestId("control-overview-task").click();
  assert.equal(await page.getByTestId("control-chat-project").inputValue(), await picker.inputValue());
  assert.match(await page.getByTestId("control-chat-input").getAttribute("placeholder") ?? "", /Describe the task for Internal Assistant/);
  await page.getByTestId("control-overview-ask").click();
  assert.match(await page.getByTestId("control-chat-input").getAttribute("placeholder") ?? "", /Ask Bob about Internal Assistant/);

  // A conversation opens from its headline, over the control center.
  await page.getByTestId("control-overview-conversation").first().click();
  await page.waitForFunction(() => document.body.classList.contains("view-control") && document.body.classList.contains("control-popup"));
});
