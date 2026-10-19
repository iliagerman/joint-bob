import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { conversationScopeId, getScopeSecretAccounts, persistConversationSecretAccounts, saveSecretAccount, setScopeSecretAccounts } from "../src/secrets.js";
import { reviewAccountIds } from "../src/server/git-review-run.js";

test("Ask AI inherits the latest conversation segment's accounts across engines and refreshes changes", async () => {
  const first = await saveSecretAccount({ label: "Old test account", provider: "custom", variables: [{ name: "TEST_PIPELINE_TOKEN", kind: "value", value: "synthetic-old" }] });
  const current = await saveSecretAccount({ label: "Current test account", provider: "custom", variables: [{ name: "TEST_PIPELINE_TOKEN", kind: "value", value: "synthetic-current" }] });
  await ensureConversationRecord("review-project", "pi", "review-old", "test-node", undefined, { conversationId: "review-conversation", segmentIndex: 0 });
  await ensureConversationRecord("review-project", "claude", "review-current", "test-node", undefined, { conversationId: "review-conversation", segmentIndex: 1 });
  await setScopeSecretAccounts("conversation", conversationScopeId("pi", "review-old"), [first.id]);
  await setScopeSecretAccounts("conversation", conversationScopeId("claude", "review-current"), [current.id]);
  const ids = await reviewAccountIds("review-project", "review-conversation");
  assert.deepEqual(ids, [current.id]);
  await persistConversationSecretAccounts("pi", "review-throwaway", ids);
  assert.deepEqual((await getScopeSecretAccounts("conversation", conversationScopeId("pi", "review-throwaway"))).accountIds, [current.id]);
  await setScopeSecretAccounts("conversation", conversationScopeId("claude", "review-current"), []);
  assert.deepEqual(await reviewAccountIds("review-project", "review-conversation"), []);
  await assert.rejects(reviewAccountIds("other-project", "review-conversation"), /not found/i);
});

test("only interactive Ask AI enables checks, on initial questions and follow-ups", async () => {
  const routes = await readFile(new URL("../src/server/routes/git-review.ts", import.meta.url), "utf8");
  assert.match(routes, /useTools: true,\s+conversationId: payload.conversationId \?\? undefined/);
  assert.match(routes, /useTools: true,\s+conversationId: thread.conversationId \?\? undefined/);
  const runner = await readFile(new URL("../src/server/git-review-run.ts", import.meta.url), "utf8");
  assert.match(runner, /if \(!input.useTools\) await restrictToReadOnly\(session\)/);
  assert.match(runner, /never print or expose secret values/);
  for (const name of ["git-review-guide.ts", "git-change-story.ts"]) {
    const source = await readFile(new URL(`../src/server/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /useTools: true/);
  }
});
