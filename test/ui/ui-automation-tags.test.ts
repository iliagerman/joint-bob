import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("settings manages workspace tags and automation forms keep manual tags separate", { timeout: 180_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-automation-tags").click();
  await page.waitForFunction(() => document.querySelectorAll("#automationTagsWorkspace option").length > 0);
  await page.getByTestId("automation-tags-new-name").fill("Nightly review");
  await page.getByTestId("automation-tags-add").click();
  await page.waitForFunction(() => [...document.querySelectorAll("#automationTagsList input")].some(input => input.value === "Nightly review"));
  const tagId = await page.locator("#automationTagsWorkspace").evaluate(async select => {
    const workspaceId = select.value;
    const response = await fetch(`/api/workspaces/${workspaceId}/automation-tags`);
    return (await response.json()).tags[0].id;
  });
  await page.getByTestId("settings-cancel-button").click();
  await page.locator('[aria-label="Actions for Internal Assistant"]').click();
  await page.getByTestId("project-cron-button").click();
  await page.getByTestId("cron-new").click();
  await page.getByTestId("cron-name").fill("Tagged nightly");
  await page.getByTestId("cron-prompt").fill("Review the project");
  await page.getByTestId("cron-tags-managed").selectOption(tagId);
  await page.getByTestId("cron-tags-manual").fill("One-off");
  await page.getByTestId("cron-tags-add-manual").click();
  await page.getByTestId("cron-save").click();
  await page.getByText("Tagged nightly", { exact: true }).waitFor();
  const saved = await page.evaluate(async () => {
    const projects = await (await fetch("/api/projects")).json();
    const projectId = projects.projects.find(project => project.name === "Internal Assistant").id;
    const tasks = await (await fetch(`/api/projects/${projectId}/cron`)).json();
    return tasks.tasks.find(task => task.name === "Tagged nightly").tags;
  });
  assert.deepEqual(saved, { managedTagIds: [tagId], manualTags: ["One-off"] });
  await page.getByTestId("cron-close").click();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-automation-tags").click();
  await page.locator("#automationExecutionsSummary").waitFor();
  assert.match(await page.getByTestId("automation-executions-summary").innerText(), /Executions 0/);
});
