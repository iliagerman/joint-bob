import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { authRequest, fixtureDatabase, fixtureTotp, responseSession } from "./mfa-fixture.js";
import { signedNodeRequest } from "./signed-node-request.js";

async function eventually(check: () => void, message: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (true) {
    try { check(); return; } catch { assert.ok(Date.now() < deadline, message); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

test("synced authenticator signs in with home offline, survives restart, and updates only from home", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "offline-mfa-"));
  const envA = await seedDevEnvironment(path.join(root, "a"), 1, { username: "ana" });
  const envB = await seedDevEnvironment(path.join(root, "b"), 1, { username: "ben" });
  const a = envA.nodes[0], b = envB.nodes[0];
  let home = await startDevNode(envA, a), visitor = await startDevNode(envB, b);
  const dbA = fixtureDatabase(a), dbB = fixtureDatabase(b);
  try {
    const sa = await signIn(envA, a), sb = await signIn(envB, b);
    const setup = await authRequest(a, "/mfa/setup", { currentPassword: envA.password }, sa);
    const enabled = await authRequest(a, "/mfa/confirm", { code: fixtureTotp(setup.body.secret) }, sa);
    assert.equal(enabled.response.status, 200);
    const secret: string = setup.body.secret, codes: string[] = enabled.body.recoveryCodes;
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name: "Offline MFA" });
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(a, sa, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(b, sb, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    const factor = () => dbB.prepare("SELECT m.* FROM user_mfa m JOIN users u ON m.user_id = u.id WHERE u.username = 'ana'").get();
    await eventually(() => assert.ok(factor()), "MFA key must reach the other cluster node");
    const stored = String(factor()!.secret_encrypted);
    assert.notEqual(stored, dbA.prepare("SELECT secret_encrypted FROM user_mfa").get()!.secret_encrypted, "receiver encrypts under its own key");
    assert.ok(!JSON.stringify(dbB.prepare("SELECT * FROM user_mfa").all()).includes(secret), "no plaintext key at rest");
    assert.equal(dbB.prepare("SELECT count(*) n FROM mfa_recovery_codes").get()!.n, 0, "recovery codes stay home");
    const login = () => authRequest(b, "/login", { username: "ana@example.test", password: envA.password });
    const complete = (challenge: string, code: string) => authRequest(b, "/login/mfa", { challenge, code });
    await stopDevNode(home);
    let pending = await login();
    assert.equal(pending.response.status, 200);
    assert.equal(pending.body.offlineMfa, true);
    assert.equal(pending.response.headers.get("set-cookie"), null);
    assert.equal((await fetch(`${b.url}/api/projects`)).status, 401, "password proof has no app access");
    dbB.prepare("UPDATE mfa_login_challenges SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    assert.equal((await complete(pending.body.challenge, fixtureTotp(secret))).response.status, 401, "expired proofs cannot sign in offline");
    pending = await login();
    const code = fixtureTotp(secret);
    const accepted = await complete(pending.body.challenge, code);
    assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.isRemoteLogin, true);
    assert.equal(accepted.body.role, null);
    const session = responseSession(accepted.response, accepted.body);
    assert.equal((await authRequest(b, "/status", undefined, session)).body.authenticated, true);
    assert.equal((await complete(pending.body.challenge, code)).response.status, 401, "proof is single-use");
    for (const endpoint of ["/mfa/setup", "/mfa/confirm", "/mfa/disable", "/mfa/recovery-codes"]) {
      const body = endpoint === "/mfa/setup" ? { currentPassword: envA.password } : endpoint === "/mfa/confirm" ? { code } : { currentPassword: envA.password, code };
      assert.equal((await authRequest(b, endpoint, body, session)).response.status, 403, "visitors cannot overwrite their home MFA policy");
    }
    await stopDevNode(visitor);
    visitor = await startDevNode(envB, b);
    pending = await login();
    assert.equal((await complete(pending.body.challenge, code)).response.status, 401, "restart preserves the per-node replay counter");
    dbB.prepare("DELETE FROM login_attempts WHERE username LIKE 'mfa:%'").run();
    for (let i = 0; i < 5; i++) {
      pending = await login();
      assert.equal((await complete(pending.body.challenge, "000000")).response.status, 401);
    }
    assert.equal((await login()).response.status, 429, "offline TOTP attempts are limited across fresh challenges");
    await stopDevNode(visitor);
    visitor = await startDevNode(envB, b);
    assert.equal((await login()).response.status, 429, "restart preserves the offline failure budget");
    dbB.prepare("DELETE FROM login_attempts WHERE username LIKE 'mfa:%'").run();
    pending = await login();
    assert.equal((await complete(pending.body.challenge, codes[0])).response.status, 503, "recovery codes are never spent independently offline");
    const fresh = fixtureTotp(secret, 1);
    assert.equal((await complete(pending.body.challenge, fresh)).response.status, 200, "authenticator still works after offline recovery refusal");
    const lastUsed = factor()!.last_used_step;
    home = await startDevNode(envA, a);
    // A fresh, signed resend must not roll back this node's replay counter.
    const local = dbA.prepare("SELECT * FROM users WHERE username = 'ana'").get()!;
    const snapshot = { version: 3, accounts: [{ accountId: accepted.body.accountId, username: "ana", email: "ana@example.test", passwordHash: Buffer.from(local.password_hash as Uint8Array).toString("hex"), passwordSalt: Buffer.from(local.password_salt as Uint8Array).toString("hex"), mfaRequired: true, mfaSecret: secret, updatedAt: String(local.updated_at), clusterIds: [clusterId] }] };
    const sync = (body: unknown) => signedNodeRequest(envA, a, b, "POST", "/api/cluster/v2/accounts/offline-mfa", body);
    assert.equal((await sync(snapshot)).status, 200);
    assert.equal(factor()!.last_used_step, lastUsed, "resending the same key never resets replay protection");
    assert.equal((await fetch(`${b.url}/api/cluster/v2/accounts/offline-mfa`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot) })).status, 401, "unsigned key replication is rejected");
    assert.equal((await sync({ ...snapshot, accounts: [{ ...snapshot.accounts[0], mfaSecret: null }] })).status, 400, "required MFA cannot arrive without a key in v3");
    assert.equal((await sync({ ...snapshot, accounts: [...snapshot.accounts, { ...snapshot.accounts[0], username: "outsider", email: "outsider@example.test", accountId: "f".repeat(32), clusterIds: [] }] })).status, 200);
    assert.equal(dbB.prepare("SELECT 1 FROM users WHERE username = 'outsider'").get(), undefined, "a key never grants access outside its account's shared clusters");
    const beforeRotation = await login();
    assert.equal((await authRequest(a, "/mfa/disable", { currentPassword: envA.password, code: codes[0] }, sa)).response.status, 200);
    const replacement = await authRequest(a, "/mfa/setup", { currentPassword: envA.password }, sa);
    assert.equal((await authRequest(a, "/mfa/confirm", { code: fixtureTotp(replacement.body.secret) }, sa)).response.status, 200);
    await eventually(() => { assert.ok(factor()); assert.notEqual(factor()!.secret_encrypted, stored); }, "rotated MFA must sync");
    assert.equal((await complete(beforeRotation.body.challenge, fixtureTotp(secret))).response.status, 401, "rotation invalidates pending proofs");
    assert.equal((await authRequest(b, "/status", undefined, session)).body.authenticated, false, "rotation revokes old visitor sessions");
    await stopDevNode(home);
    pending = await login();
    assert.equal((await complete(pending.body.challenge, fixtureTotp(replacement.body.secret))).response.status, 200, "replacement authenticator works offline");
    const beforeBlock = await login();
    assert.equal((await api(b, sb, "PUT", `/node-blocks/${a.nodeId}`, { blocked: true })).status, 200);
    assert.equal(factor(), undefined, "blocking deletes the replicated key even with home offline");
    assert.equal((await complete(beforeBlock.body.challenge, fixtureTotp(replacement.body.secret, 1))).response.status, 401);
    assert.equal((await login()).response.status, 401);
  } finally {
    dbA.close(); dbB.close();
    await stopDevNode(home); await stopDevNode(visitor);
    await rm(root, { recursive: true, force: true });
  }
});
