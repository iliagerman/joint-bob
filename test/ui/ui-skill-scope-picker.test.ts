import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("skill picker requests and caches skills per conversation, discarding late replies", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t, (root) => ({ JOINT_BOB_TEST_ENGINE_LOG: `${root}/engine.log` }));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card", { hasText: "Thread-Based Agent Builder" }).click();
  const requested: string[] = [];
  let release: (() => void) | undefined;
  await page.route("**/api/projects/*/skills*", async (route) => {
    const conversation = new URL(route.request().url()).searchParams.get("conversationId") || "missing";
    requested.push(conversation);
    if (conversation === "slow-conversation") await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { skills: [{ name: `${conversation}-skill`, description: "Scoped test", harness: "pi", scope: "project" }] } });
  });
  const load = (id: string, force = false) => page.evaluate(async ({ id, force }) => {
    const { state } = await import("/app/state.js");
    state.activeConversationId = id;
    await (await import("/app/composer-dialogs.js")).loadSkills(force);
    return state.skills.map((skill: { name: string }) => skill.name);
  }, { id, force });
  assert.deepEqual(await load("conversation-one", true), ["conversation-one-skill"], "request must include active conversation");
  assert.deepEqual(await load("conversation-two"), ["conversation-two-skill"], "same project must not reuse another conversation's skills");
  assert.deepEqual(requested, ["conversation-one", "conversation-two"]);
  await load("conversation-two");
  assert.equal(requested.length, 2, "same conversation uses its cache");
  const slow = load("slow-conversation");
  await page.waitForRequest((request) => new URL(request.url()).searchParams.get("conversationId") === "slow-conversation");
  assert.deepEqual(await load("latest-conversation"), ["latest-conversation-skill"], "new context can load while old request is pending");
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  await slow;
  const current = await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    return { names: state.skills.map((skill: { name: string }) => skill.name), loading: state.skillsLoading };
  });
  assert.deepEqual(current, { names: ["latest-conversation-skill"], loading: false });
});
