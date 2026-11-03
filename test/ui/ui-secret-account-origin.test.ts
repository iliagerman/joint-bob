// A secret account made on one of this person's own machines reaches its twin read-only. Its row
// said "Shared with me · read-only", as if someone else had shared it; it is the same person's
// account, edited on the machine it came from. The node now says which twin an account came from
// (test/cluster-sanity.test.ts checks that, and test/multi-cluster.test.ts that another person's
// machine's account is not called a twin's); this checks the row says it in plain words.
import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

const FROM_TWIN = { id: "00000000-0000-4000-8000-00000000a001", label: "Deploy keys", provider: "custom", replicate: false, variables: [{ name: "DEPLOY_TOKEN", kind: "value", configured: true }], shared: true, readOnly: true, ownerNodeId: "00000000-0000-4000-8000-0000000000aa", ownerTwin: true, ownerNodeName: "MacBook Pro" };
const FROM_TEAMMATE = { id: "00000000-0000-4000-8000-00000000a002", label: "Team staging", provider: "custom", replicate: true, variables: [{ name: "STAGING_TOKEN", kind: "value", configured: true }], shared: true, readOnly: true, ownerNodeId: "00000000-0000-4000-8000-0000000000bb" };

test("an account from this person's own twin says where it is edited; another person's stays a read-only share", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  // The two accounts as the node lists them on the receiving machine.
  await page.route("**/api/secrets", async (route) => {
    const response = await route.fetch().catch(() => null);
    if (!response) return;
    const body = await response.json() as { accounts: unknown[] };
    await route.fulfill({ response, json: { ...body, accounts: [...body.accounts, FROM_TWIN, FROM_TEAMMATE] } }).catch(() => undefined);
  });
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-secrets").click();

  const row = (id: string) => page.getByTestId("secret-account-list").locator(`.secret-account-row[data-account-id="${id}"]`);
  await row(FROM_TWIN.id).waitFor();
  const twinStatus = await row(FROM_TWIN.id).getByTestId("secret-account-share-status").innerText();
  assert.equal(twinStatus, "From MacBook Pro · edit it there");
  assert.doesNotMatch(await row(FROM_TWIN.id).innerText(), /Shared with me/, "the person's own account is not called a share");
  assert.equal(await row(FROM_TEAMMATE.id).getByTestId("secret-account-share-status").innerText(), "Shared with me · read-only");
  for (const id of [FROM_TWIN.id, FROM_TEAMMATE.id]) {
    assert.equal(await row(id).getByTestId("secret-account-edit-button").count(), 0, "neither can be edited on this machine");
  }
});
