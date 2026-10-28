import assert from "node:assert/strict";
import { test } from "node:test";
import { ProfileLogins } from "../src/provider-profiles/login.js";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("login sends only interaction metadata to its owner and persists tokens after completion", async () => {
  const logins = new ProfileLogins();
  let stored = "";
  logins.start("alice", "p", "claude", async (interaction) => {
    interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize?state=fixture" });
    assert.equal(await interaction.prompt({ type: "manual_code", message: "Paste redirect" }), "private-code");
    return { type: "oauth", access: "private-access", refresh: "private-refresh", expires: Date.now() + 100_000 };
  }, async (credential) => { stored = JSON.stringify(credential); });
  assert.equal(logins.status("bob", "p"), undefined);
  assert.equal(logins.status("alice", "p")?.prompt?.type, "manual_code");
  assert.throws(() => logins.answer("bob", "p", "wrong"), /no pending/);
  assert.throws(() => logins.start("bob", "q", "claude", async () => { throw new Error(); }, async () => {}), /already in progress/);
  logins.answer("alice", "p", "private-code");
  await tick();
  assert.equal(logins.status("alice", "p")?.state, "complete");
  assert.match(stored, /private-access/);
  assert.doesNotMatch(JSON.stringify(logins.status("alice", "p")), /private-/);
});

test("cancellation cannot report a cancelled login after credential persistence begins", async () => {
  const logins = new ProfileLogins();
  let finish!: () => void;
  let stored = false;
  logins.start("alice", "saving", "openai-codex", async () => ({ type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 100_000 }), async () => {
    await new Promise<void>((resolve) => { finish = resolve; });
    stored = true;
  });
  await tick();
  assert.throws(() => logins.cancel("alice", "saving"), /finishing/);
  finish();
  await tick();
  assert.equal(stored, true);
  assert.equal(logins.status("alice", "saving")?.state, "complete");
});

test("cancelled login cannot persist a late result and errors never expose provider response bodies", async () => {
  const logins = new ProfileLogins();
  let finish!: () => void;
  let stored = false;
  logins.start("alice", "cancel", "claude", async () => {
    await new Promise<void>((resolve) => { finish = resolve; });
    return { type: "oauth", access: "secret", refresh: "secret", expires: 1 };
  }, async () => { stored = true; });
  logins.cancel("alice", "cancel");
  finish();
  await tick();
  assert.equal(stored, false);
  assert.equal(logins.status("alice", "cancel")?.state, "cancelled");
  logins.start("alice", "failure", "claude", async () => { throw new Error("provider body secret-token"); }, async () => {});
  await tick();
  assert.equal(logins.status("alice", "failure")?.state, "failed");
  assert.doesNotMatch(JSON.stringify(logins.status("alice", "failure")), /secret-token/);
});
