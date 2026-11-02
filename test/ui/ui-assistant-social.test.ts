import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";
import { launchChrome } from "./launch-chrome.js";

/** Lists fit their space and page: none of them may scroll vertically. */
async function assertListsFit(page: Page, label: string): Promise<void> {
  const overflowing = await page.locator(".res-list").evaluateAll(lists => lists.filter(list => list.scrollHeight > list.clientHeight + 1).length);
  assert.equal(overflowing, 0, `${label}: a list scrolls instead of paging`);
}

test("assistant shell: resources, public actions, activity and discovery without a relay", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assistant-social-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card").first().waitFor();
    const projectId = node.projects[0].id;
    const assistantId = await page.evaluate(async (project) => {
      const { csrfToken } = await (await fetch("/api/auth/status")).json();
      const { sessions } = await (await fetch(`/api/projects/${project}/sessions`)).json();
      const response = await fetch("/api/personal-assistants", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ projectId: project, engine: sessions[0].harnessId, sessionId: sessions[0].id, name: "Work assistant", instructions: "" }) });
      return (await response.json()).assistant.id as string;
    }, projectId);

    // The desktop workspace switches to assistants with its own button, and back.
    await page.getByTestId("projects-open-assistants-button").click();
    await page.locator("#rail-assistants").getByText("Work assistant").waitFor();
    await page.locator(".brand-workspace").click();
    await page.locator(".project-card").first().waitFor();

    // Desktop shell: rail with the assistant, tabs, and Resources.
    await page.goto(`${node.url}/assistant.html?id=${assistantId}&view=resources`);
    await page.locator("#heading").getByText("Work assistant").waitFor();
    assert.equal(await page.locator("#rail").isVisible(), true, "desktop shows the rail");
    assert.equal(await page.locator("#tabbar").isVisible(), false, "desktop has no bottom tabs");
    await page.getByTestId("assistant-resources-section-browser").waitFor();
    assert.equal(await page.locator(".side-item").count(), 5, "five resource sections");
    await page.getByText("No logins yet. Add one and sign in yourself. Every topic can use it.").waitFor();
    await page.getByTestId("assistant-add-login").click();
    await page.locator("#add-login").waitFor();
    await page.getByRole("button", { name: "Saved login" }).click();
    await page.getByText("No saved logins to attach.").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("#overlay").waitFor({ state: "hidden" });
    await page.getByTestId("assistant-resources-section-skills").click();
    await page.getByTestId("assistant-resources-skills").waitFor();
    await assertListsFit(page, "desktop skills");
    const skillSwitch = page.getByTestId("assistant-resources-skills").locator(".switch").first();
    if (await skillSwitch.count()) {
      const saved = page.waitForResponse(response => response.url().endsWith(`/api/personal-assistants/${assistantId}/resources`) && response.request().method() === "PUT");
      await skillSwitch.click();
      assert.equal((await saved).status(), 200, "turning a skill off saves the assistant's choice");
      assert.equal(await page.getByTestId("assistant-resources-skills").locator(".switch").first().getAttribute("aria-checked"), "false");
    }
    await page.getByTestId("assistant-resources-section-secrets").click();
    await page.getByTestId("assistant-resources-secrets").waitFor();
    await assertListsFit(page, "desktop secrets");

    // Public actions: drafts need an operation, then publish and disable.
    await page.getByTestId("assistant-view-actions").click();
    await page.getByText("No public actions yet.", { exact: false }).waitFor();
    await page.getByTestId("assistant-new-action").click();
    await page.locator("#action-form").waitFor();
    await page.locator("#action-form [name=name]").fill("Share my travel plan");
    await page.locator("#action-form [name=description]").fill("Tells people when I'm away.");
    await page.getByTestId("assistant-publish-action").click();
    await page.locator("#message", { hasText: "Choose what this action is allowed to do" }).waitFor();
    await page.locator("#action-form input[value='info.share']").check();
    await page.locator("#action-form [name=shareText]").fill("Away 10–14 Nov.");
    await page.getByTestId("assistant-publish-action").click();
    await page.locator("#actions-view .card-top .chip", { hasText: "Published" }).waitFor();
    await page.getByTestId("assistant-action-test").locator("button[type=submit]").click();
    await page.getByTestId("assistant-action-test-result").waitFor();
    assert.match(await page.getByTestId("assistant-action-test-result").textContent() || "", /No decision|Do it|Ask you first|Decline/, "a test shows the decision model's answer, or that it gave none");
    await page.getByRole("button", { name: "Disable", exact: true }).click();
    await page.locator("#actions-view .card-top .chip", { hasText: "Disabled" }).waitFor();

    // Activity: empty, private, and closing returns to the same chat.
    await page.getByTestId("assistant-view-chat").click();
    await page.locator("#chat-form").waitFor();
    await page.getByTestId("assistant-activity-button").click();
    await page.getByTestId("assistant-activity").getByText("Nothing yet.", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Close activity and return to chat" }).click();
    await page.locator("#overlay").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#chat-form").isVisible(), true);

    // Who can find you and Find, with no relay on this machine.
    await page.locator("#rail-you").click();
    await page.getByText("This machine isn't on a relay yet.", { exact: false }).waitFor();
    await page.getByRole("radio", { name: "Work assistant" }).click();
    await page.locator("#message", { hasText: "Work assistant is your default" }).waitFor();
    assert.equal(await page.getByRole("radio", { name: "Work assistant" }).getAttribute("aria-checked"), "true");
    await page.locator(".rail-search").click();
    await page.getByText("This machine isn't on a relay yet.", { exact: false }).waitFor();
    await page.locator("#rail-groups").getByText("Invitations").click();
    await page.getByText("No invitations yet.").waitFor();

    // Phone: bottom tabs on lists, full-screen details, Resources pages instead of scrolling.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${node.url}/assistant.html`);
    await page.locator("#chooser").waitFor({ state: "visible" });
    assert.equal(await page.locator("#tabbar").isVisible(), true, "lists show the bottom tabs");
    assert.equal(await page.locator("#rail").isVisible(), false);
    await page.locator("#tabbar [data-tab=groups]").click();
    await page.locator("#social-view").getByText("Invitations").waitFor();
    await page.locator("#tabbar [data-tab=assistants]").click();
    await page.getByRole("button", { name: "Work assistant", exact: true }).click();
    await page.locator("#chat-form").waitFor({ state: "visible" });
    assert.equal(await page.locator("#tabbar").isVisible(), false, "a detail screen hides the bottom tabs");
    await page.getByTestId("assistant-view-resources").click();
    await page.getByTestId("assistant-resources-section-skills").click();
    await page.getByText("Back to resources").waitFor();
    await assertListsFit(page, "phone skills");
    const tabsFit = await page.locator("#assistant-nav").evaluate(tabs => tabs.scrollWidth <= tabs.clientWidth + 1);
    assert.equal(tabsFit, true, "assistant tabs fit a phone width");
    await page.getByText("Back to resources").click();
    assert.equal(await page.locator(".side-item").count(), 5);
    assert.deepEqual(errors, [], "the page runs without script errors");
  } finally {
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
