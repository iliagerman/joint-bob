import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("command search ranks names, supports abbreviations and ignores hidden prompt text", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card", { hasText: "Thread-Based Agent Builder" }).click();
  const commands = [
    { id: "review", name: "pr_review", prompt: "Review code and deploy if ready" },
    { id: "prod", name: "prompte to prod", prompt: "Run the release steps" },
    { id: "deploy", name: "Deploy", prompt: "Ship changes" },
  ];
  await page.route("**/api/commands?*", (route) => route.fulfill({ json: { commands, recentIds: ["prod"] } }));
  await page.getByTestId("saved-commands-button").click();
  const options = page.getByTestId("saved-command-option"), search = page.getByTestId("saved-commands-search");
  await options.waitFor();
  assert.deepEqual(await options.allTextContents(), ["prompte to prod"]);
  await search.fill("d");
  assert.deepEqual(await options.allTextContents(), ["Deploy", "prompte to prod"]);
  await search.fill("  PR REV  ");
  assert.deepEqual(await options.allTextContents(), ["pr_review"]);
  await search.fill("release steps");
  assert.deepEqual(await options.allTextContents(), []);
  await search.fill("");
  assert.deepEqual(await options.allTextContents(), ["prompte to prod"]);
});

test("command picker limits recents, searches received commands, preserves drafts on errors and stale replies", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t, (root) => ({ JOINT_BOB_TEST_ENGINE_LOG: `${root}/engine.log` }));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card", { hasText: "Thread-Based Agent Builder" }).click();
  const commands = Array.from({ length: 8 }, (_, i) => ({ id: `node/command:${i}`, name: i === 7 ? "Received review" : `Command ${i}`, prompt: `Prompt ${i}`, receivedFrom: i === 7 ? "Peer" : undefined }));
  let empty = false;
  let history = true;
  await page.route("**/api/commands?*", (route) => route.fulfill({ json: { commands: empty ? [] : commands, recentIds: empty || !history ? [] : ["node/command:4", "node/command:3", "node/command:2", "node/command:1", "node/command:0"] } }));
  let fail = true;
  let release: (() => void) | undefined;
  let delayed = false;
  await page.route("**/api/commands/*/use", async (route) => {
    if (delayed) await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ status: fail ? 500 : 200, json: fail ? { error: "Record use failed" } : { ok: true } });
  });
  const draft = page.getByTestId("chat-message-input");
  const open = page.getByTestId("saved-commands-button");
  // Let the socket finish opening the conversation before testing composer availability.
  await page.waitForFunction(() => !(document.querySelector("#messageInput") as HTMLTextAreaElement).disabled);
  await page.evaluate(async () => (await import("/app/chat-controls.js")).setComposerEnabled(false));
  assert.equal(await open.isDisabled(), true, "Commands button must follow composer availability");
  await page.evaluate(async () => (await import("/app/chat-controls.js")).setComposerEnabled(true));
  const search = page.getByTestId("saved-commands-search");
  await draft.fill("Keep my draft");
  await open.click();
  await page.getByTestId("saved-command-option").first().waitFor();
  assert.deepEqual(await page.getByTestId("saved-command-option").allTextContents(), ["Command 4", "Command 3", "Command 2", "Command 1", "Command 0"]);
  await search.fill("Received");
  assert.equal(await page.getByTestId("saved-command-option").innerText(), "Received review");
  const failed = page.waitForResponse((response) => response.url().includes("/use") && response.status() === 500);
  await search.press("Enter"); await failed;
  assert.equal(await draft.inputValue(), "Keep my draft");
  fail = false;
  await search.fill("");
  await search.press("ArrowDown"); await search.press("ArrowUp"); await search.press("ArrowDown");
  await search.press("Enter");
  await page.waitForFunction(() => (document.querySelector("#messageInput") as HTMLTextAreaElement).value === "Prompt 3");
  await open.click(); await search.fill("Received");
  await page.getByTestId("saved-command-option").waitFor();
  delayed = true;
  const request = page.waitForRequest((request) => request.url().includes("/use"));
  await search.press("Enter"); await request;
  await page.waitForFunction(() => Boolean(document.querySelector("#savedCommandsDialog[open]")));
  const previous = await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    const id = state.activeConversationId;
    state.activeConversationId = "another-chat";
    return id;
  });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const done = page.waitForResponse((response) => response.url().includes("/use")); release(); await done;
  await search.press("Escape");
  assert.equal(await draft.inputValue(), "Prompt 3");
  await page.evaluate(async (id) => { (await import("/app/state.js")).state.activeConversationId = id; }, previous);
  empty = true;
  await open.click();
  await page.getByTestId("saved-commands-options").getByText("No commands found.", { exact: false }).waitFor();
  assert.equal(await search.isVisible(), true);
  await search.press("Escape");
  empty = false; history = false;
  assert.equal(await draft.isEnabled(), true, "Composer must still be writable after closing picker");
  assert.equal(await draft.isVisible(), true);
  await open.click();
  await page.getByTestId("saved-command-option").first().waitFor();
  assert.deepEqual(await page.getByTestId("saved-command-option").allTextContents(), ["Command 0", "Command 1", "Command 2", "Command 3", "Command 4"]);
  assert.equal(await page.locator("#savedCommandsTitle").innerText(), "Commands");
  await search.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await draft.waitFor({ state: "visible" });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const inputBox = await draft.boundingBox(), commandsBox = await open.boundingBox(), sendBox = await page.getByTestId("chat-send-button").boundingBox();
  assert.ok(inputBox && commandsBox && sendBox);
  assert.ok(inputBox.width >= 80, `mobile draft remains usable, width ${inputBox.width}`);
  assert.ok(sendBox.x + sendBox.width <= 390, `Send must fit beside commands, right edge ${sendBox.x + sendBox.width}`);
});
