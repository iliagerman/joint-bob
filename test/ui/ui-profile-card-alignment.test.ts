import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { api, signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("profile card actions stay aligned when one card has a sign-in result", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const session = await signIn(environment, node);
  const ids: string[] = [];
  for (const label of ["Work account", "Personal account"]) {
    const created = await api<{ profile: { id: string } }>(node, session, "POST", "/provider-profiles", { provider: "openai-codex", label });
    assert.equal(created.status, 201);
    ids.push(created.body.profile.id);
  }
  const saveCredential = async (id: string) => {
    const auth = path.join(node.dataDir, "provider-profile-auth", id, "auth.json");
    await mkdir(path.dirname(auth), { recursive: true, mode: 0o700 });
    await writeFile(auth, JSON.stringify({ "openai-codex": { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
  };
  await saveCredential(ids[0]);
  // Complete the external OAuth step locally; status reads the real fixture credential.
  await page.route(`${node.url}/api/provider-profiles/${ids[1]}/login`, async (route) => {
    assert.equal(route.request().method(), "POST");
    await saveCredential(ids[1]);
    await route.fulfill({ json: { login: { state: "complete", message: "Signed in on this node" } } });
  });

  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-connections").click();
  const cards = page.getByTestId("provider-profile-row");
  const personal = cards.filter({ hasText: "Personal account" });
  await personal.getByTestId("provider-profile-status").filter({ hasText: "Not signed in" }).waitFor();
  await personal.getByTestId("provider-profile-signin").click();
  await personal.getByTestId("provider-profile-login").filter({ hasText: "Signed in on this node" }).waitFor();
  await personal.getByTestId("provider-profile-signout").waitFor();
  assert.equal(await cards.filter({ hasText: "Work account" }).getByTestId("provider-profile-login").isVisible(), false, "only the newly signed-in card has the extra result");

  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const boxes = await cards.evaluateAll((items) => items.map((item) => {
      const card = item.getBoundingClientRect();
      const actions = item.querySelector(":scope > .profile-actions")!.getBoundingClientRect();
      const check = item.querySelector('[data-testid="provider-profile-check"]')!.getBoundingClientRect();
      const share = item.querySelector('[data-testid="provider-profile-sharing"]')!.getBoundingClientRect();
      return { cardTop: card.top, actionTop: actions.top, actionBottom: actions.bottom, checkTop: check.top, shareTop: share.top };
    }));
    assert.equal(boxes.length, 2);
    assert.ok(Math.abs(boxes[0].cardTop - boxes[1].cardTop) < 1, `cards share a row at ${width}px: ${JSON.stringify(boxes)}`);
    assert.ok(boxes.every((box) => box.shareTop > box.checkTop), "buttons wrap onto multiple rows");
    assert.ok(Math.abs(boxes[0].actionTop - boxes[1].actionTop) < 1, `action rows align at ${width}px: ${JSON.stringify(boxes)}`);
    assert.ok(Math.abs(boxes[0].actionBottom - boxes[1].actionBottom) < 1, `action bottoms align at ${width}px: ${JSON.stringify(boxes)}`);
  }
});
