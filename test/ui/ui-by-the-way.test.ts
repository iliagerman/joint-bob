import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("bob-btw opens read-only Chat, preserves history and clears only side-chat messages", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-btw-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") });
  let browser;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).click();
    await page.getByText("Short one", { exact: true }).click();
    const open = async () => {
      await page.getByTestId("chat-message-input").fill("/bob-btw");
      await page.locator("#composer").evaluate((form: HTMLFormElement) => form.requestSubmit());
      await page.getByTestId("conversation-chat-input").waitFor({ timeout: 5000 });
      await page.waitForFunction(() => !(document.querySelector("#conversationChatSend") as HTMLButtonElement).disabled);
    };
    await open();
    assert.equal(await page.getByTestId("activity-chat-tab").getAttribute("aria-selected"), "true");
    await page.getByTestId("conversation-chat-harness").selectOption("claude");
    await page.getByTestId("conversation-chat-input").fill("side-only question");
    let releaseQuestion!: () => void;
    const heldQuestion = new Promise<void>((resolve) => { releaseQuestion = resolve; });
    await page.route("**/api/projects/*/conversations/*/chat", async (route) => {
      if (route.request().method() === "POST") await heldQuestion;
      await route.continue();
    });
    const answering = page.waitForResponse((response) => response.url().endsWith("/chat") && response.request().method() === "POST");
    void answering.catch(() => undefined);
    await page.getByTestId("conversation-chat-send").click();
    try {
      assert.equal(await page.getByTestId("conversation-chat-input").inputValue(), "", "sending clears the composer before the server answers");
      assert.equal(await page.getByTestId("conversation-chat-messages").getByText("side-only question", { exact: true }).count(), 1, "sent question appears immediately");
      await page.getByTestId("conversation-chat-input").fill("next question draft");
    } finally { releaseQuestion(); }
    const answered = await answering;
    assert.equal(answered.status(), 202, await answered.text());
    await page.getByTestId("conversation-chat-messages").getByText("stubbed response", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("conversation-chat-input").inputValue(), "next question draft", "answers never erase a new draft");
    assert.equal(await page.getByTestId("conversation-chat-messages").getByText("side-only question", { exact: true }).count(), 1, "server history replaces rather than duplicates the optimistic question");
    assert.equal(await page.locator("#messages").getByText("side-only question", { exact: true }).count(), 0);
    await page.getByTestId("activity-activity-tab").click();
    assert.equal(await page.getByTestId("activity-body").isVisible(), true);
    await page.getByTestId("activity-chat-tab").click();
    await page.getByTestId("conversation-chat-messages").getByText("side-only question", { exact: true }).waitFor();
    await page.reload();
    await page.getByTestId("chat-message-input").waitFor();
    await open();
    await page.getByTestId("conversation-chat-messages").getByText("side-only question", { exact: true }).waitFor();
    await page.getByTestId("conversation-chat-clear").click();
    await page.waitForFunction(() => document.querySelector("#conversationChatMessages")?.textContent?.includes("Ask about this conversation"));
    await page.locator("#messages").getByText("Single short line.", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.waitForFunction(() => !document.querySelector("#settingsForm")!.hasAttribute("aria-busy"));
    await page.getByTestId("settings-tab-conversations").click();
    const savedDefaults = page.waitForResponse((response) => response.url().endsWith("/conversation-chat/settings") && response.request().method() === "PUT");
    await page.getByTestId("settings-side-chat-selectors").uncheck();
    assert.equal((await savedDefaults).status(), 200);
    await page.getByTestId("settings-dialog").evaluate((dialog: HTMLDialogElement) => dialog.close());
    await page.waitForFunction(() => (document.querySelector("#conversationChatSelectors") as HTMLElement).hidden);
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await page.getByTestId("conversation-chat-input").boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 391);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("side-chat queues follow-ups, keeps them across reload, and updates automatically in order", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-chat-queue-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const hold = path.join(root, "hold");
  await mkdir(hold);
  const engineLog = path.join(root, "engine.log");
  const server = await startDevNode(environment, node, {
    JOINT_BOB_TEST_ENGINE_LOG: engineLog, JOINT_BOB_TEST_ENGINE_HOLD_DIR: hold,
  });
  let browser;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).click();
    await page.getByText("Short one", { exact: true }).click();
    await page.getByTestId("activity-chat-tab").click();
    await page.waitForFunction(() => !(document.querySelector("#conversationChatSend") as HTMLButtonElement).disabled);
    await page.getByTestId("conversation-chat-harness").selectOption("claude");
    for (const question of ["first question", "second question", "third question"]) {
      await page.getByTestId("conversation-chat-input").fill(question);
      const accepted = page.waitForResponse((response) => response.url().endsWith("/chat") && response.request().method() === "POST");
      await page.getByTestId("conversation-chat-send").click();
      assert.equal((await accepted).status(), 202);
      assert.equal(await page.getByTestId("conversation-chat-input").inputValue(), "");
    }
    await page.getByTestId("conversation-chat-status").filter({ hasText: "2 queued" }).waitFor();
    assert.equal(await page.getByTestId("conversation-chat-send").textContent(), "Queue");
    assert.equal(await page.getByTestId("conversation-chat-send").isEnabled(), true);
    assert.equal(await page.getByTestId("conversation-chat-messages").getByText("You · Queued", { exact: true }).count(), 2);
    assert.equal((await readFile(engineLog, "utf8")).trim().split("\n").length, 1, "only the first answer may start while it is held");
    await page.reload();
    await page.getByTestId("activity-chat-tab").click();
    await page.getByTestId("conversation-chat-status").filter({ hasText: "2 queued" }).waitFor();
    await writeFile(path.join(hold, "claude.release"), "release");
    await page.waitForFunction(() => document.querySelectorAll("#conversationChatMessages article.assistant").length === 3);
    await page.waitForFunction(() => document.querySelector("#conversationChatStatus")!.textContent === "");
    const texts = await page.locator("#conversationChatMessages article .md").allTextContents();
    assert.deepEqual(texts.map((text) => text.trim()), ["first question", "stubbed response", "second question", "stubbed response", "third question", "stubbed response"]);
    assert.equal((await readFile(engineLog, "utf8")).trim().split("\n").length, 3);
    assert.equal(await page.locator("#messages").getByText("second question", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await writeFile(path.join(hold, "claude.release"), "release");
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
