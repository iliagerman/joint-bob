import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsDatabase } from "../src/settings-store.js";
import { createProviderProfile, deleteProviderProfile, profileSelectionSchema, providerProfile, setProviderProfileSelection, setProviderProfileShared } from "../src/provider-profiles/store.js";
import { replicatedEntityTypes } from "../src/replication.js";
import { EVENT_SCOPES } from "../src/server/replication-v2.js";
import * as profileService from "../src/provider-profiles/service.js";
import { getClusterNode } from "../src/cluster.js";

await getClusterNode();

type Pool = {
  id: string;
  owner: string;
  name: string;
  members: Array<{ profileId: string; position: number }>;
  fallbackModels: Record<string, string>;
};
type PoolApi = {
  createSubscriptionPool?: (owner: string, input: unknown) => Pool;
  updateSubscriptionPool?: (owner: string, id: string, input: unknown) => Pool;
  deleteSubscriptionPool?: (owner: string, id: string) => void;
  getSubscriptionPool?: (owner: string, id: string) => Pool;
  listSubscriptionPools?: (owner: string) => Pool[];
  setSubscriptionPoolChoice?: (owner: string, input: unknown) => void;
  resolveSubscriptionChoice?: (owner: string, provider: string, scope: { projectId: string; workspaceId: string; conversationId?: string }) => unknown;
  poolCandidates?: (pool: Pool, preferredProvider: string) => Array<{ id: string; provider: string }>;
};
const poolApi = profileService as unknown as PoolApi;
function required<T>(value: T | undefined): T {
  assert.equal(typeof value, "function", "subscription pool API is missing");
  return value!;
}

const scope = { projectId: "pool-project", workspaceId: "pool-workspace", conversationId: "pool-conversation" };
const selection = (choice: { profileId?: string | null; poolId?: string | null }) => ({ provider: "claude", scope: "default", scopeId: "", profileId: null, ...choice });

test("pool selections accept a pool ID without a profile ID", () => {
  const poolId = "00000000-0000-4000-8000-000000000001";
  assert.equal(profileSelectionSchema.safeParse({ provider: "claude", scope: "default", scopeId: "", profileId: null, poolId }).success, true);
});

test("pool CRUD preserves order, owner, and provider-specific fallback models", () => {
  const create = required(poolApi.createSubscriptionPool);
  const update = required(poolApi.updateSubscriptionPool);
  const get = required(poolApi.getSubscriptionPool);
  const list = required(poolApi.listSubscriptionPools);
  const aliceClaude = createProviderProfile("pool-alice", { label: "Claude A", provider: "claude" });
  const aliceCodex = createProviderProfile("pool-alice", { label: "Codex", provider: "openai-codex" });
  const pool = create("pool-alice", { name: "Primary", profileIds: [aliceClaude.id, aliceCodex.id], fallbackModels: { "openai-codex": "gpt-5-codex" } });

  assert.equal(pool.owner, "pool-alice");
  assert.equal(pool.name, "Primary");
  assert.deepEqual(pool.members, [{ profileId: aliceClaude.id, position: 0 }, { profileId: aliceCodex.id, position: 1 }]);
  assert.deepEqual(pool.fallbackModels, { "openai-codex": "gpt-5-codex" });
  assert.equal(get("pool-alice", pool.id).id, pool.id);
  assert.deepEqual(list("pool-alice").map(({ id }) => id), [pool.id]);
  assert.deepEqual(list("pool-bob"), []);
  assert.throws(() => get("pool-bob", pool.id), /not found/i);

  const updated = update("pool-alice", pool.id, { name: "Backup", profileIds: [aliceCodex.id, aliceClaude.id], fallbackModels: { claude: "claude-sonnet-4" } });
  assert.equal(updated.name, "Backup");
  assert.deepEqual(updated.members, [{ profileId: aliceCodex.id, position: 0 }, { profileId: aliceClaude.id, position: 1 }]);
  assert.deepEqual(updated.fallbackModels, { claude: "claude-sonnet-4" });
  assert.throws(() => deleteProviderProfile("pool-alice", aliceClaude.id), /pool/i);
});

test("pool creation rejects empty, duplicate, foreign, or nonexistent profiles", () => {
  const create = required(poolApi.createSubscriptionPool);
  const alice = createProviderProfile("pool-validation", { label: "Owned", provider: "claude" });
  const foreign = createProviderProfile("pool-other", { label: "Private", provider: "claude" });
  assert.throws(() => create("pool-validation", { name: "Empty", profileIds: [] }), /profile|empty/i);
  assert.throws(() => create("pool-validation", { name: "Duplicate", profileIds: [alice.id, alice.id] }), /unique/i);
  assert.throws(() => create("pool-validation", { name: "Foreign", profileIds: [foreign.id] }), /not found|owner|profile/i);
  assert.throws(() => create("pool-validation", { name: "Missing", profileIds: ["00000000-0000-4000-8000-000000000099"] }), /not found|profile/i);
  assert.throws(() => create("pool-validation", { name: " ", profileIds: [alice.id] }), /too small|name/i);
  assert.throws(() => create("pool-validation", { name: "Bad model", profileIds: [alice.id], fallbackModels: { claude: " " } }), /too small|claude/i);
  assert.throws(() => create("pool-validation", { name: "Bad provider", profileIds: [alice.id], fallbackModels: { unknown: "model" } }), /unknown|unrecognized/i);
});

test("automation-only profiles cannot be shared into an interactive pool", () => {
  const create = required(poolApi.createSubscriptionPool);
  const candidates = required(poolApi.poolCandidates);
  const profile = createProviderProfile("pool-private", { label: "Private", provider: "claude" });
  const pool = create("pool-private", { name: "Private pool", profileIds: [profile.id] });
  assert.throws(() => setProviderProfileShared("pool-private", profile.id, true), /pools/i);
  assert.equal(providerProfile("pool-private", profile.id).shared, false);
  settingsDatabase().prepare("UPDATE provider_profiles SET shared=1 WHERE id=?").run(profile.id);
  assert.throws(() => candidates(pool, "claude"), /automation-only/i);
});

test("pool candidates try the preferred provider first and preserve order within each provider", () => {
  const create = required(poolApi.createSubscriptionPool);
  const candidates = required(poolApi.poolCandidates);
  const claudeFirst = createProviderProfile("pool-order", { label: "Claude first", provider: "claude" });
  const codex = createProviderProfile("pool-order", { label: "Codex", provider: "openai-codex" });
  const claudeSecond = createProviderProfile("pool-order", { label: "Claude second", provider: "claude" });
  const pool = create("pool-order", { name: "Mixed", profileIds: [claudeFirst.id, codex.id, claudeSecond.id] });

  assert.deepEqual(candidates(pool, "openai-codex").map(({ id }) => id), [codex.id, claudeFirst.id, claudeSecond.id]);
  assert.deepEqual(candidates(pool, "claude").map(({ id }) => id), [claudeFirst.id, claudeSecond.id, codex.id]);
});

test("pool selection follows scope precedence and blocks another user's pool ID", () => {
  const create = required(poolApi.createSubscriptionPool);
  const setPoolChoice = required(poolApi.setSubscriptionPoolChoice);
  const resolve = required(poolApi.resolveSubscriptionChoice);
  const claude = createProviderProfile("pool-scope", { label: "Claude", provider: "claude" });
  const codex = createProviderProfile("pool-scope", { label: "Codex", provider: "openai-codex" });
  const pool = create("pool-scope", { name: "Scope", profileIds: [claude.id, codex.id] });

  setPoolChoice("pool-scope", { scope: "default", scopeId: "", poolId: pool.id });
  assert.deepEqual(resolve("pool-scope", "claude", scope), { kind: "pool", pool, source: "default" });
  setProviderProfileSelection("pool-scope", { provider: "claude", scope: "project", scopeId: scope.projectId, profileId: claude.id });
  assert.deepEqual(resolve("pool-scope", "claude", scope), { kind: "profile", profile: claude, source: "project" });
  setPoolChoice("pool-scope", { scope: "conversation", scopeId: JSON.stringify([scope.projectId, scope.conversationId]), poolId: pool.id });
  assert.deepEqual(resolve("pool-scope", "claude", scope), { kind: "pool", pool, source: "conversation" });
  assert.equal(resolve("another-user", "claude", scope), undefined);
  assert.throws(() => setPoolChoice("another-user", { scope: "default", scopeId: "", poolId: pool.id }), /not found|owner|pool/i);
});

test("a pool cannot be deleted while selected, but deleting after clearing its choice succeeds", () => {
  const create = required(poolApi.createSubscriptionPool);
  const remove = required(poolApi.deleteSubscriptionPool);
  const get = required(poolApi.getSubscriptionPool);
  const setPoolChoice = required(poolApi.setSubscriptionPoolChoice);
  const claude = createProviderProfile("pool-delete", { label: "Claude", provider: "claude" });
  const pool = create("pool-delete", { name: "Selected", profileIds: [claude.id] });
  setPoolChoice("pool-delete", { scope: "default", scopeId: "", poolId: pool.id });
  assert.throws(() => remove("pool-delete", pool.id), /selection/i);
  setProviderProfileSelection("pool-delete", selection({ profileId: null }));
  remove("pool-delete", pool.id);
  assert.throws(() => get("pool-delete", pool.id), /not found/i);
  assert.equal(settingsDatabase().prepare("SELECT 1 FROM subscription_pools WHERE id=? AND deleted=0").get(pool.id), undefined);
});

test("a pool assignment covers every provider its profiles use, and clearing it clears them all", () => {
  const create = required(poolApi.createSubscriptionPool);
  const setPoolChoice = required(poolApi.setSubscriptionPoolChoice);
  const resolve = required(poolApi.resolveSubscriptionChoice);
  const claude = createProviderProfile("pool-fan", { label: "Claude", provider: "claude" });
  const codex = createProviderProfile("pool-fan", { label: "Codex", provider: "openai-codex" });
  const pool = create("pool-fan", { name: "Both", profileIds: [claude.id, codex.id] });

  setPoolChoice("pool-fan", { scope: "workspace", scopeId: scope.workspaceId, poolId: pool.id });
  assert.deepEqual(resolve("pool-fan", "claude", scope), { kind: "pool", pool, source: "workspace" });
  assert.deepEqual(resolve("pool-fan", "openai-codex", scope), { kind: "pool", pool, source: "workspace" });
  setPoolChoice("pool-fan", { scope: "workspace", scopeId: scope.workspaceId, poolId: null });
  assert.notEqual((resolve("pool-fan", "claude", scope) as { kind?: string } | undefined)?.kind, "pool");
  assert.notEqual((resolve("pool-fan", "openai-codex", scope) as { kind?: string } | undefined)?.kind, "pool");
});

test("editing a pool's profiles moves its assignments with them", () => {
  const create = required(poolApi.createSubscriptionPool);
  const update = required(poolApi.updateSubscriptionPool);
  const setPoolChoice = required(poolApi.setSubscriptionPoolChoice);
  const resolve = required(poolApi.resolveSubscriptionChoice);
  const claude = createProviderProfile("pool-edit", { label: "Claude", provider: "claude" });
  const codex = createProviderProfile("pool-edit", { label: "Codex", provider: "openai-codex" });
  const pool = create("pool-edit", { name: "Edited", profileIds: [claude.id] });
  setPoolChoice("pool-edit", { scope: "default", scopeId: "", poolId: pool.id });

  const edited = update("pool-edit", pool.id, { name: "Edited", profileIds: [codex.id] });
  assert.deepEqual(resolve("pool-edit", "openai-codex", scope), { kind: "pool", pool: edited, source: "default" });
  assert.notEqual((resolve("pool-edit", "claude", scope) as { kind?: string } | undefined)?.kind, "pool");
});

test("pool metadata and selections replicate only through twin-scoped event types without credentials", () => {
  const owner = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const createProfile = createProviderProfile(owner, { label: "Sync", provider: "claude" });
  const create = required(poolApi.createSubscriptionPool);
  const setPoolChoice = required(poolApi.setSubscriptionPoolChoice);
  const pool = create(owner, { name: "Shared only with twins", profileIds: [createProfile.id] });
  setPoolChoice(owner, { scope: "default", scopeId: "", poolId: pool.id });

  const selectionKey = JSON.stringify([owner, "claude", "default", ""]);
  const rows = settingsDatabase().prepare("SELECT entity_type AS entityType,entity_key AS entityKey,payload FROM replication_outbox WHERE entity_key=? OR entity_key=?").all(pool.id, selectionKey) as Array<{ entityType: string; entityKey: string; payload: string }>;
  const events = rows.map((row) => ({ type: row.entityType, payload: JSON.parse(row.payload) as Record<string, unknown> }));
  const poolEvent = events.find(({ type }) => type === "provider.pool");
  const selectionEvent = events.find(({ type }) => type === "provider.poolSelection");
  assert.ok(poolEvent);
  assert.ok(selectionEvent);
  assert.deepEqual(Object.keys(poolEvent.payload).sort(), ["createdAt", "deleted", "fallbackModels", "id", "members", "name", "originNodeId", "updatedAt", "username"]);
  assert.deepEqual(Object.keys(selectionEvent.payload).sort(), ["originNodeId", "poolId", "provider", "scope", "scopeId", "updatedAt", "username"]);
  assert.equal(selectionEvent.payload.poolId, pool.id);
  assert.equal(EVENT_SCOPES["provider.pool"], "twins-only");
  assert.equal(EVENT_SCOPES["provider.poolSelection"], "twins-only");
  assert.ok(replicatedEntityTypes().includes("provider.pool"));
  assert.ok(replicatedEntityTypes().includes("provider.poolSelection"));
});
