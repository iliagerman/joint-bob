import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Run with npm run test:file -- test/project-session-timing.test.ts.
// Endpoint regressions use the same disposable HOME/data setup in test/setup.mjs.
test("project session stages use only static, code-owned timing labels", async () => {
  const source = ts.createSourceFile("sessions-helpers.ts", await readFile(new URL("../src/server/sessions-helpers.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const stages = new Map<string, string>();
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "measureOperation") {
      assert.equal(node.arguments.length, 2, "no private timing fields");
      const [label, callback] = node.arguments;
      assert.ok(ts.isStringLiteral(label), "stage must not interpolate paths, IDs or content");
      assert.ok(ts.isArrowFunction(callback) || ts.isIdentifier(callback));
      assert.ok(!stages.has(label.text), "one measurement per stage, not per session");
      stages.set(label.text, callback.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.deepEqual([...stages.keys()], [
    "sessions.review_scope", "sessions.transcript_catalog", "sessions.agent_dashboards",
    "sessions.supervisor_tasks", "sessions.external_runtime", "sessions.decoration_review",
    "sessions.ownership", "sessions.notifications", "sessions.worktrees",
  ]);
  for (const [stage, calls] of Object.entries({
    "sessions.external_runtime": ["Promise.all", "getHarnessRuntime", "runtime.externalRunning"],
    "sessions.decoration_review": ["applyConversationWork", "syncConversationReviewDetails"],
    "sessions.ownership": ["Promise.all", "getConversationOwnership"],
    "sessions.notifications": ["migratePortableNotifications", "ntfySubscribedSessionPaths"],
    "sessions.worktrees": ["worktreeConversationIndex"],
  })) {
    for (const call of calls) assert.ok(stages.get(stage)?.includes(`${call}(`), `${stage} covers ${call}`);
  }
  assert.ok(stages.get("sessions.notifications")!.indexOf("await migratePortableNotifications") < stages.get("sessions.notifications")!.indexOf("await ntfySubscribedSessionPaths"));
});
