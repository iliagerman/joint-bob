import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

async function login(page: Page, url: string, username: string, password: string): Promise<void> {
  await page.goto(url);
  await page.getByTestId("login-username-input").fill(username);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-cluster").click();
  await page.getByTestId("cluster-item").first().click();
  await page.getByTestId("cluster-tab-budget").click();
  await page.getByTestId("cluster-budget-grid").waitFor();
}

test("the manager edits the cluster budget and a member sees it read-only", { timeout: 240_000 }, async () => {
  const roots: string[] = [];
  const servers: ChildProcess[] = [];
  let browser: Browser | undefined;
  try {
    for (const name of ["m", "n"]) roots.push(await mkdtemp(path.join(os.tmpdir(), `joint-bob-ui-budget-${name}-`)));
    const [managerEnv, memberEnv] = await Promise.all(roots.map((root) => seedDevEnvironment(root, 1)));
    const [manager, member] = [managerEnv.nodes[0], memberEnv.nodes[0]];
    servers.push(await startDevNode(managerEnv, manager), await startDevNode(memberEnv, member));
    const [managerSession, memberSession] = await Promise.all([signIn(managerEnv, manager), signIn(memberEnv, member)]);
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(manager, managerSession, "POST", "/clusters", { name: "Team" });
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(manager, managerSession, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(member, memberSession, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);

    browser = await launchChrome({ headless: process.env.HEADED !== "1" });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", serviceWorkers: "block" });
    page.setDefaultTimeout(15_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await login(page, manager.url, managerEnv.username, managerEnv.password);
    const cell = (row: string, period: string) => page.locator(`[data-budget-row="${row}"][data-budget-period="${period}"]`);
    assert.match(await page.getByTestId("cluster-budget").innerText(), /No budget set yet/);
    assert.equal(await cell("limits", "day").isDisabled(), false, "the manager can edit");
    await cell("limits", "day").fill("25");
    await cell("project", "month").fill("10");
    await cell("conversation", "total").fill("2.5");
    await page.getByTestId("cluster-budget-save").click();
    await page.getByText("Budget saved").waitFor();
    assert.match(await page.getByTestId("cluster-budget").innerText(), /Revision 1/);

    const saved = (await api<any>(manager, managerSession, "GET", "/budgets/clusters")).body.clusters[0];
    assert.deepEqual(saved.policy.limits, [{ period: "day", usd: 25 }]);
    assert.deepEqual(saved.policy.defaults.project, [{ period: "month", usd: 10 }]);
    assert.deepEqual(saved.policy.defaults.conversation, [{ period: "total", usd: 2.5 }]);

    await cell("limits", "day").fill("-3");
    await page.getByTestId("cluster-budget-save").click();
    await page.getByText(/Too small|greater than|Number must/i).first().waitFor();

    // The member's copy arrives on its own and cannot be edited.
    const deadline = Date.now() + 40_000;
    for (;;) {
      const seen = (await api<any>(member, memberSession, "GET", "/budgets/clusters")).body.clusters[0];
      if (seen?.revision === 1) break;
      assert.ok(Date.now() < deadline, "the member receives the budget");
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const memberPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", serviceWorkers: "block" });
    memberPage.setDefaultTimeout(15_000);
    await login(memberPage, member.url, memberEnv.username, memberEnv.password);
    const memberCell = memberPage.locator('[data-budget-row="limits"][data-budget-period="day"]');
    assert.equal(await memberCell.inputValue(), "25");
    assert.equal(await memberCell.isDisabled(), true, "a member cannot edit");
    assert.equal(await memberPage.getByTestId("cluster-budget-save").count(), 0);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    for (const server of servers) await stopDevNode(server);
    for (const root of roots) await rm(root, { recursive: true, force: true });
  }
});
