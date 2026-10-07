// A conversation whose transcript changes between loads logs which messages
// changed and how the node built the payload, so a shrinking transcript names its cause.
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { projectNamed } from "../dev-nodes.js";
import { claudeProjectDir } from "../../src/session-paths.js";

const PROJECT_NAME = "Internal Assistant";
const CONVERSATION_TITLE = "Scroll follow reference";
const CONVERSATION_ID = "5f8c3a71-9b2e-4d67-a3c1-72e5d8f04b19";

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a transcript that changes between loads logs the changed messages and the payload diagnostics", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: PROJECT_NAME }).first().click();
  await page.locator(".session-card", { hasText: CONVERSATION_TITLE }).first().click();
  await waitUntil(() => logs.some((line) => line.startsWith("Conversation transcript ready")), "the conversation to open");

  const ready = await page.evaluate(`window.jointBobClientLogs.entries().find((entry) => entry.includes("Conversation transcript ready"))`) as string;
  const readyFields = JSON.parse(ready.slice(ready.indexOf("{")));
  assert.equal(readyFields.sessionId, CONVERSATION_ID);
  assert.equal(readyFields.load, "open");
  assert.equal(readyFields.runtime, "loaded", `the ready log must say how the node built the payload: ${ready}`);
  assert.equal(typeof readyFields.runtimeMessages, "number");
  assert.equal(readyFields.trimmed, false);

  const project = projectNamed(node, PROJECT_NAME);
  const transcript = path.join(claudeProjectDir(project.path, path.join(environment.home, ".claude", "projects")), `${CONVERSATION_ID}.jsonl`);
  const id = `${CONVERSATION_ID}-diagnostic-0`;
  await appendFile(transcript, `${JSON.stringify({ type: "user", uuid: id, cwd: project.path, timestamp: "2026-09-30T09:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Diagnostic marker arrived from disk" }] } })}\n`);
  await waitUntil(() => logs.some((line) => line.startsWith("Conversation transcript differs from its previous load")), "the transcript diff log");

  const diff = await page.evaluate(`window.jointBobClientLogs.entries().find((entry) => entry.includes("Conversation transcript differs from its previous load"))`) as string;
  const fields = JSON.parse(diff.slice(diff.indexOf("{")));
  assert.equal(fields.conversation, CONVERSATION_ID);
  assert.deepEqual(fields.removed, [], `nothing was removed: ${diff}`);
  assert.deepEqual(fields.changed, [], `no existing message changed: ${diff}`);
  const marker = "Diagnostic marker arrived from disk";
  assert.deepEqual(fields.added.map((entry: { role: string; length: number }) => [entry.role, entry.length]), [["user", marker.length]], `the appended message is named: ${diff}`);
  assert.equal(fields.messagesAfter, fields.messagesBefore + 1);
  assert.ok(!diff.includes("Diagnostic marker"), "the log carries lengths and hashes, never message text");
});
