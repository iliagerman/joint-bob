import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { CronStore, cronInputSchema } from "../src/cron.js";
import { createWebhook, updateWebhook, webhookInputSchema, webhookForSecret } from "../src/webhooks.js";
import { createProviderProfile, setProviderProfileShared, deleteProviderProfile } from "../src/provider-profiles/store.js";
import { automationProfileContext } from "../src/provider-profiles/context.js";
import { assertAutomationCreator, runWithAutomationProfile } from "../src/server/automation-profile.js";
import { assertQueuedPromptEditor, enqueuePrompt, listQueuedPrompts, mergeQueuedPrompts, clearQueuedPrompts } from "../src/prompt-queue.js";

test("queued automation identity survives persistence and cannot merge into an interactive turn", async () => {
  await (await import("../src/cluster.js")).getClusterNode();
  const key = `p:${randomUUID()}`;
  const automationProfile = { accountId: "alice", profileId: randomUUID(), nodeId: randomUUID() };
  const metadata = { messageText: "test", promptSuffix: "", displaySuffix: "", attachmentPaths: [], settings: null };
  try {
    const first = enqueuePrompt(key, "test", "test", { ...metadata, automationProfile });
    const second = enqueuePrompt(key, "test", "test", metadata);
    assert.deepEqual(listQueuedPrompts(key)[0].automationProfile, automationProfile);
    assert.equal(mergeQueuedPrompts(key, [first, second]), null);
  } finally { clearQueuedPrompts(key); }
});

test("queue edits and merges cannot turn another author's profile into an execution capability", async () => {
  await (await import("../src/cluster.js")).getClusterNode();
  const key = `p:${randomUUID()}`;
  const author = (accountId: string) => ({ accountId, username: "Fixture", email: null, homeNodeId: null });
  const alice = "a".repeat(32), bob = "b".repeat(32);
  const metadata = { messageText: "test", promptSuffix: "", displaySuffix: "", attachmentPaths: [], settings: null };
  try {
    const first = enqueuePrompt(key, "alice", "alice", { ...metadata, author: author(alice) });
    const second = enqueuePrompt(key, "bob", "bob", { ...metadata, author: author(bob) });
    assertQueuedPromptEditor(first, alice);
    assert.throws(() => assertQueuedPromptEditor(first, bob), /author/);
    assert.throws(() => assertQueuedPromptEditor(first, undefined), /author/);
    assert.equal(mergeQueuedPrompts(key, [first, second]), null);
    const automated = enqueuePrompt(key, "auto", "auto", { ...metadata, author: author(alice), automationProfile: { accountId: alice, profileId: null, nodeId: randomUUID() } });
    assert.throws(() => assertQueuedPromptEditor(automated, alice), /automation/);
  } finally { clearQueuedPrompts(key); }
});

test("only the creator can change automation execution settings, including inherited profiles", () => {
  assertAutomationCreator("alice", "alice");
  assert.throws(() => assertAutomationCreator("alice", "bob"), /creator/);
  assert.throws(() => assertAutomationCreator("alice", undefined), /creator/);
  assertAutomationCreator(null, "alice");
});

test("schedules persist creator and nullable profile through updates and run-now", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new CronStore(db);
    const input = cronInputSchema.parse({ name: "Profile job", prompt: "Test", projectId: "p", ownerNodeId: randomUUID(), engine: "claude", sessionId: null, enabled: true, creatorAccountId: "alice", providerProfileId: "profile", schedule: { frequency: "daily", hour: 9, minute: 0, weekday: 1, timezone: "UTC" } });
    const task = store.create(input);
    assert.equal(store.runNow(task.id).providerProfileId, "profile");
    assert.equal(store.get(task.id)?.creatorAccountId, "alice");
    store.update(task.id, { ...input, providerProfileId: null });
    assert.equal(store.get(task.id)?.providerProfileId, null);
  } finally { db.close(); }
});

test("webhooks persist creator and explicit profile, and clear assignment to null", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const input = webhookInputSchema.parse({ name: "Test", target: { kind: "project", projectId: "p" }, creatorAccountId: "alice", providerProfileId: "profile" });
    const { webhook, secret } = createWebhook(db, input);
    assert.equal(webhookForSecret(db, secret)?.creatorAccountId, "alice");
    assert.equal(webhookForSecret(db, secret)?.providerProfileId, "profile");
    updateWebhook(db, webhook.id, { ...input, providerProfileId: null });
    assert.equal(webhookForSecret(db, secret)?.providerProfileId, null);
  } finally { db.close(); }
});

test("automation validates owned/shared profiles on every run and preserves async context", async () => {
  const profile = createProviderProfile("alice", { label: "Synthetic", provider: "claude" });
  const input = { creatorAccountId: "bob", providerProfileId: profile.id };
  assert.throws(() => runWithAutomationProfile(input, () => undefined), /not found|revoked/);
  setProviderProfileShared("alice", profile.id, true);
  await runWithAutomationProfile(input, async () => {
    await Promise.resolve();
    assert.deepEqual(automationProfileContext(), { accountId: "bob", profileId: profile.id });
  });
  assert.equal(automationProfileContext(), undefined);
  runWithAutomationProfile(input, () => {
    runWithAutomationProfile({}, () => assert.equal(automationProfileContext(), undefined, "unassigned work must not inherit another automation's identity"));
    assert.equal(automationProfileContext()?.accountId, "bob");
  });
  setProviderProfileShared("alice", profile.id, false);
  assert.throws(() => runWithAutomationProfile(input, () => undefined), /not found|revoked/);
  runWithAutomationProfile({ creatorAccountId: "alice", providerProfileId: null }, () => assert.deepEqual(automationProfileContext(), { accountId: "alice", profileId: null }));
  deleteProviderProfile("alice", profile.id);
  assert.throws(() => runWithAutomationProfile({ ...input, creatorAccountId: "alice" }, () => undefined), /not found|revoked/);
  assert.throws(() => runWithAutomationProfile({ providerProfileId: profile.id }, () => undefined), /creator/);
});
