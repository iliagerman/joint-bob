import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

const exec = promisify(execFile);
async function browser(...args: string[]): Promise<unknown> {
  const cli = process.env.JOINT_BOB_BROWSER_CLI;
  assert.ok(cli, "Designated JOINT_BOB_BROWSER_CLI is required; no local browser fallback");
  const { stdout } = await exec(process.execPath, [cli, ...args], { timeout: 30_000 });
  const response = JSON.parse(stdout) as { result?: unknown; session?: unknown };
  assert.ok(response.result !== undefined || response.session, "Browser executor returned no result");
  return response.result;
}
async function evaluate(expression: string): Promise<unknown> {
  return browser("evaluate", expression);
}
async function waitFor(expression: string): Promise<void> {
  assert.equal(await evaluate(`(async () => { const end = Date.now() + 10000; while (!(${expression})) { if (Date.now() > end) throw Error(${JSON.stringify(`Timed out: ${expression}`)}); await new Promise(resolve => setTimeout(resolve, 50)); } return true; })()`), true);
}
const click = (selector: string): Promise<unknown> => browser("click", selector);
const fill = (selector: string, text: string): Promise<unknown> => browser("fill", selector, text);

test("designated browser: project and conversation schedules, edit, pause, history, delete and Cron filter", { timeout: 180_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "joint-bob-cron-ui-")));
  const environment = await seedDevEnvironment(root, 1);
  const server = await startDevNode(environment, environment.nodes[0]);
  try {
    await browser("start");
    await browser("navigate", environment.nodes[0].url);
    await waitFor('document.querySelector("#loginDialog").open');
    await fill("#loginUsernameInput", environment.username);
    await fill("#loginPasswordInput", environment.password);
    await click("#loginSubmitButton");
    await waitFor('document.querySelectorAll("#projectList .list-row").length === 3');
    await click('[aria-label="Actions for Internal Assistant"]');
    await click('[data-testid="project-cron-button"]');
    await waitFor('document.querySelector("#cronDialog").open && document.querySelector("#cronForm").elements.ownerNodeId.options.length > 0');
    await click("#cronNew");
    assert.equal(await evaluate(`(() => {
      const form = document.querySelector("#cronForm"), f = form.elements;
      f.name.value = "Project browser cron"; f.prompt.value = "Scheduled project prompt";
      f.frequency.value = "weekly"; f.frequency.dispatchEvent(new Event("change", { bubbles: true }));
      f.timezone.value = "UTC"; f.enabled.checked = false;
      if (document.querySelector("#cronWeekdayLabel").hidden || document.querySelector("#cronTimeLabel").hidden || !document.querySelector("#cronMinuteLabel").hidden) throw Error("Weekly controls incorrect");
      if (document.querySelector("#cronEngineLabel").hidden) throw Error("Project task needs an agent selector");
      form.requestSubmit(); return true;
    })()`), true);
    await waitFor('document.querySelector("#cronList").textContent.includes("Project browser cron · New conversationPaused")');
    await click('[data-testid="cron-edit"]');
    assert.equal(await evaluate(`(() => {
      const form = document.querySelector("#cronForm"), f = form.elements;
      if (f.frequency.value !== "weekly" || f.timezone.value !== "UTC" || f.enabled.checked) throw Error("Saved schedule not restored");
      f.name.value = "Edited project cron"; f.frequency.value = "daily";
      f.frequency.dispatchEvent(new Event("change", { bubbles: true }));
      if (!document.querySelector("#cronWeekdayLabel").hidden) throw Error("Daily schedule shows weekday");
      form.requestSubmit(); return true;
    })()`), true);
    await waitFor('document.querySelector("#cronList").textContent.includes("Edited project cron")');
    await click('[data-testid="cron-toggle"]');
    await waitFor('document.querySelector("#cronList").textContent.includes("Next:")');
    await click('[data-testid="cron-toggle"]');
    await waitFor('document.querySelector("#cronList").textContent.includes("Paused")');
    await click('[data-testid="cron-history"]');
    await waitFor('document.querySelector("#cronList pre")?.textContent === "Not run yet"');
    await click("#cronClose");
    await evaluate('[...document.querySelectorAll("#projectList .list-row")].find(row => row.textContent.includes("Internal Assistant")).querySelector("button").click()');
    await click('[data-filter="all"]');
    await waitFor('[...document.querySelectorAll("#sessionList .list-row")].some(row => row.textContent.includes("Short one"))');
    await evaluate('[...document.querySelectorAll("#sessionList .list-row")].find(row => row.textContent.includes("Short one")).querySelector(".row-menu-button").click()');
    await click('[data-testid="session-cron-button"]');
    await waitFor('document.querySelector("#cronDialog").open && document.querySelector("#cronList").textContent.includes("No scheduled tasks")');
    await click("#cronNew");
    assert.equal(await evaluate(`(() => {
      const form = document.querySelector("#cronForm"), f = form.elements;
      if (!document.querySelector("#cronEngineLabel").hidden) throw Error("Conversation should inherit its agent");
      f.name.value = "Conversation browser cron"; f.prompt.value = "Scheduled append";
      f.timezone.value = "UTC"; f.enabled.checked = false;
      form.requestSubmit(); return true;
    })()`), true);
    await waitFor('document.querySelector("#cronList").textContent.includes("Conversation browser cron · Existing conversationPaused")');
    await click("#cronClose");
    await click('[data-testid="chats-filter-cron-button"]');
    await waitFor('document.querySelectorAll("#sessionList .list-row").length === 1 && document.querySelector("#sessionList .list-row").textContent.includes("Short one")');
    await browser("navigate", environment.nodes[0].url);
    await waitFor('document.querySelector("[data-filter-count=cron]").textContent === "1"');
    await click('[aria-label="Actions for Internal Assistant"]');
    await click('[data-testid="project-cron-button"]');
    await waitFor('document.querySelectorAll("#cronList .cron-task").length === 2');
    await evaluate('[...document.querySelectorAll("#cronList .cron-task")].find(row => row.textContent.includes("Edited project cron")).querySelector("[data-testid=cron-delete]").click()');
    await waitFor('document.querySelector("#confirmDialog").open');
    await click("#confirmAcceptButton");
    await waitFor('document.querySelectorAll("#cronList .cron-task").length === 1');
    assert.equal(await evaluate('document.querySelector("#cronList").textContent.includes("Conversation browser cron") && !document.querySelector("#cronList").textContent.includes("Edited project cron")'), true);
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
