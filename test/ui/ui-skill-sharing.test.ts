import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("Settings → Resources shares single and bulk skills with clusters, workspaces and conversations, pages long lists, and removes managed skills", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-sharing-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    const source = path.join(environment.home, "JointBob/.agent-resources/shared/skills/portable");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\nname: portable\ndescription: UI fixture skill\n---\n");
    for (let index = 1; index <= 24; index += 1) {
      const name = `bulk-${String(index).padStart(2, "0")}`;
      const folder = path.join(environment.home, "JointBob/.agent-resources/shared/skills", name);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Bulk fixture ${index}\n---\n`);
    }
    server = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    const clusterIds: Record<string, string> = {};
    for (const name of ["Home", "Work"]) {
      const created = await api<{ snapshot: { body: { clusterId: string } } }>(node, session, "POST", "/clusters", { name });
      assert.equal(created.status, 201);
      clusterIds[name] = created.body.snapshot.body.clusterId;
    }
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
    await page.getByTestId("chat-resources-button").click();
    const panel = page.getByTestId("resources-panel");
    const pageLabel = page.getByTestId("resources-list-pager").getByTestId("resources-page-label");
    await pageLabel.getByText(/^1–\d+ of \d+$/).waitFor();
    const perPage = await page.getByTestId("resources-skill-row").count();
    assert.ok(perPage >= 3, `a page shows several skills (${perPage})`);
    assert.ok(await panel.evaluate((element) => element.querySelector("#resourcesList")!.scrollHeight <= element.querySelector("#resourcesList")!.clientHeight + 1), "the list pages instead of scrolling");
    await page.getByTestId("resources-list-pager").getByTestId("resources-page-next").click();
    await pageLabel.getByText(new RegExp(`^${perPage + 1}–`)).waitFor();

    await page.getByTestId("resources-search-input").fill("bulk-0");
    await page.getByTestId("resources-select-all").click();
    const bar = page.getByTestId("resources-share-bar");
    await bar.getByTestId("resources-selected-count").getByText("9 skills selected").waitFor();
    await bar.getByTestId("resources-share-open").click();
    let dialog = page.getByTestId("skill-share-dialog");
    await dialog.getByText("No other nodes in your clusters yet.").waitFor();
    await dialog.getByRole("checkbox", { name: /^Work · / }).check();
    await dialog.getByTestId("skill-share-save").click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("resources-status").getByText(/Shared 9 skills with Work \(cluster\)/).waitFor();
    const bulk = await api<{ skills: Array<{ name: string; clusterIds: string[] }> }>(node, session, "GET", "/resources/skills/sharing");
    for (let index = 1; index <= 9; index += 1) assert.deepEqual(bulk.body.skills.find((skill) => skill.name === `bulk-0${index}`)?.clusterIds, [clusterIds.Work]);
    assert.deepEqual(bulk.body.skills.find((skill) => skill.name === "bulk-10")?.clusterIds, []);
    await page.getByTestId("resources-skill-row").filter({ hasText: "bulk-01" }).getByText("Shared with Work (cluster)", { exact: true }).waitFor();

    await page.getByTestId("resources-search-input").fill("portable");
    const row = page.getByTestId("resources-skill-row").filter({ hasText: "UI fixture skill" });
    await row.getByTestId("skill-sharing-summary").getByText("Local only", { exact: true }).waitFor();
    await row.getByTestId("skill-share-button").click();
    dialog = page.getByTestId("skill-share-dialog");
    await dialog.getByRole("checkbox", { name: /^Home · / }).check();
    const workspace = dialog.getByTestId("skill-share-workspace").first();
    const workspaceId = await workspace.getAttribute("data-value");
    await workspace.check();
    await dialog.getByRole("checkbox", { name: /^This conversation/ }).check();
    await dialog.getByTestId("skill-share-save").click();
    await page.getByTestId("confirm-accept-button").click();
    await row.getByTestId("skill-sharing-summary").getByText(/^Shared with Home \(cluster\), .+ \+1$/).waitFor();
    type Policy = { name: string; clusterIds: string[]; workspaceIds: string[]; conversations: Array<{ projectId: string; conversationId: string }> };
    let portable = (await api<{ skills: Policy[] }>(node, session, "GET", "/resources/skills/sharing")).body.skills.find((skill) => skill.name === "portable")!;
    assert.deepEqual(portable.clusterIds, [clusterIds.Home]);
    assert.deepEqual(portable.workspaceIds, [workspaceId]);
    assert.equal(portable.conversations.length, 1, "This conversation is shared");
    const projectId = portable.conversations[0].projectId;

    await row.getByTestId("skill-share-button").click();
    dialog = page.getByTestId("skill-share-dialog");
    assert.equal(await dialog.getByRole("checkbox", { name: /^Home · / }).isChecked(), true);
    assert.equal(await dialog.getByRole("checkbox", { name: /^Work · / }).isChecked(), false);
    await dialog.getByRole("checkbox", { name: /^Home · / }).uncheck();
    await dialog.getByTestId("skill-share-workspace").first().uncheck();
    const current = dialog.getByRole("checkbox", { name: /^This conversation/ });
    const currentId = await current.getAttribute("data-conversation");
    await current.uncheck();
    await dialog.getByTestId("skill-share-conversation-project").selectOption(projectId);
    const choice = dialog.getByTestId("skill-share-conversation-select");
    await choice.locator("option").nth(2).waitFor({ state: "attached" });
    const values = await choice.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    const otherConversation = values.find((value) => value && value !== currentId)!;
    await choice.selectOption(otherConversation);
    await dialog.getByTestId("skill-share-conversation-add").click();
    await dialog.getByTestId("skill-share-save").click();
    await page.getByTestId("confirm-accept-button").click();
    await dialog.waitFor({ state: "detached" });
    portable = (await api<{ skills: Policy[] }>(node, session, "GET", "/resources/skills/sharing")).body.skills.find((skill) => skill.name === "portable")!;
    assert.deepEqual([portable.clusterIds, portable.workspaceIds], [[], []]);
    assert.deepEqual(portable.conversations.map((item) => item.conversationId), [otherConversation], "a conversation picked from another list is shared");

    await row.getByTestId("skill-share-button").click();
    dialog = page.getByTestId("skill-share-dialog");
    await dialog.locator('input[data-testid="skill-share-conversation"]:checked').uncheck();
    await dialog.getByTestId("skill-share-save").click();
    await row.getByTestId("skill-sharing-summary").getByText("Local only", { exact: true }).waitFor();

    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box = await panel.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
    await row.getByTestId("skill-remove").click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("resources-status").getByText(/Removed\. Backup:/).waitFor();
    assert.equal(await row.count(), 0);
    const state = await api<{ skills: Array<{ name: string }> }>(node, session, "GET", "/resources/skills/sharing");
    assert.equal(state.body.skills.some((skill) => skill.name === "portable"), false);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
