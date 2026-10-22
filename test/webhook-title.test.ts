import assert from "node:assert/strict";
import test from "node:test";
import {
  bindWebhookTitle, fillWebhookTitle, revokeWebhookTitleAgentTokens, titlePlaceholders,
  webhookConversationTitle, webhookTitleAgentEnvironment, webhookTitleAgentIdentity, webhookTitleTemplateSchema,
} from "../src/webhook-title.js";

test("agents fill bracketed descriptions without changing fixed title text", () => {
  assert.equal(fillWebhookTitle("pr-[PR_REVIEW]", { PR_REVIEW: "Fix login timeout" }), "pr-Fix login timeout");
  assert.equal(fillWebhookTitle("[REPO] / pr-[PR] / [REPO]", { REPO: "api", PR: "42" }), "api / pr-42 / api");
  assert.equal(fillWebhookTitle("fixed [WHAT] suffix", { WHAT: "$& [literal]" }), "fixed $& [literal] suffix");
  assert.equal(fillWebhookTitle("קבוע-[תיאור]", { תיאור: "תיקון כניסה" }), "קבוע-תיקון כניסה");
  assert.equal(fillWebhookTitle(" fixed title ", {}), " fixed title ");
  assert.throws(() => fillWebhookTitle("pr-[PR]", { PR: "42", prefix: "other" }), /exactly/);
  assert.throws(() => fillWebhookTitle("pr-[PR]", {}), /exactly/);
  assert.throws(() => fillWebhookTitle("pr-[PR]", { PR: "\n42" }), /single-line/);
  assert.throws(() => fillWebhookTitle("pr-[PR]", { PR: "  " }), /nonempty/);
  assert.throws(() => fillWebhookTitle("pr-[PR]", { PR: "x".repeat(200) }), /200/);
});

test("templates reject malformed brackets and keep blank templates optional", () => {
  assert.deepEqual(titlePlaceholders("pr-[PR_REVIEW]-[PR_REVIEW]"), ["PR_REVIEW"]);
  assert.equal(webhookTitleTemplateSchema.parse(undefined), "");
  assert.equal(webhookTitleTemplateSchema.parse("  "), "");
  for (const invalid of ["pr-[", "pr-[]", "pr-[ ]", "pr-[[nested]]", "pr-[bad\tname]", "pr-[PR]\n", "x".repeat(201)]) {
    assert.equal(webhookTitleTemplateSchema.safeParse(invalid).success, false, invalid);
  }
});

test("template snapshots and capability tokens are scoped to one conversation and revoked on deletion", () => {
  const identity = { projectId: "webhook-title-project", engine: "pi" as const, conversationId: "webhook-title-conversation" };
  bindWebhookTitle(identity.projectId, identity.conversationId, "pr-[REVIEW]");
  const env = webhookTitleAgentEnvironment(identity);
  assert.deepEqual(webhookTitleAgentIdentity(env.JOINT_BOB_WEBHOOK_TITLE_TOKEN!), identity);
  assert.equal(webhookConversationTitle(identity.projectId, identity.conversationId), "pr-[REVIEW]");
  assert.equal(webhookConversationTitle(identity.projectId, "unrelated-conversation"), undefined);
  assert.equal(webhookTitleAgentIdentity("not-a-token"), undefined);
  revokeWebhookTitleAgentTokens(identity.projectId, identity.conversationId);
  assert.equal(webhookTitleAgentIdentity(env.JOINT_BOB_WEBHOOK_TITLE_TOKEN!), undefined);
  assert.equal(webhookConversationTitle(identity.projectId, identity.conversationId), undefined);
});
