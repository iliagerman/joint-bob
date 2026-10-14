import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { authRequest, fixtureDatabase, fixtureTotp, responseSession } from "./mfa-fixture.js";
import { signedNodeRequest } from "./signed-node-request.js";

function gatewayPost(port: number, host: string, endpoint: string, body: unknown): Promise<{ status: number; body: any; cookie: string[] | undefined }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path: `/api/auth${endpoint}`, headers: { Host: host, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text), cookie: response.headers["set-cookie"] }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

test("legacy visitors without a synced key use home verification; recovery codes and opt-outs stay authoritative", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-mfa-"));
  const envA = await seedDevEnvironment(path.join(root, "a"), 1, { username: "ana" });
  const envB = await seedDevEnvironment(path.join(root, "b"), 1, { username: "ben" });
  const a = envA.nodes[0], b = envB.nodes[0];
  let home = await startDevNode(envA, a);
  const visitor = await startDevNode(envB, b);
  const dbB = fixtureDatabase(b), dbA = fixtureDatabase(a);
  try {
    const sa = await signIn(envA, a), sb = await signIn(envB, b);
    const setup = await authRequest(a, "/mfa/setup", { currentPassword: envA.password }, sa);
    const enabled = await authRequest(a, "/mfa/confirm", { code: fixtureTotp(setup.body.secret) }, sa);
    assert.equal(enabled.response.status, 200);
    const codes: string[] = enabled.body.recoveryCodes;
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name: "MFA test" });
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(a, sa, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(b, sb, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    const deadline = Date.now() + 45_000;
    while (!dbB.prepare("SELECT 1 FROM users WHERE username = 'ana' AND remote_mfa = 1").get()) {
      assert.ok(Date.now() < deadline, "home MFA policy reaches the visitor node");
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    // Simulate a record from a v2 home, before offline keys were part of replication.
    dbB.prepare("DELETE FROM user_mfa WHERE user_id IN (SELECT id FROM users WHERE username = 'ana')").run();
    const login = () => authRequest(b, "/login", { username: "ana@example.test", password: envA.password });
    const complete = (challenge: string, code: string) => authRequest(b, "/login/mfa", { challenge, code });
    const pending = await login();
    assert.equal(pending.response.status, 200, JSON.stringify(pending.body));
    assert.equal(pending.body.mfaRequired, true, "home MFA offers the normal second step on another node");
    assert.equal(pending.body.mfaSetupRequired, undefined, "visitors never create a replacement factor");
    assert.equal(pending.response.headers.get("set-cookie"), null);
    assert.equal((await fetch(`${b.url}/api/projects`)).status, 401, "password proof grants no app access");
    assert.equal((await complete(pending.body.challenge, "invalid")).response.status, 401);
    const totp = fixtureTotp(setup.body.secret, 1);
    const accepted = await complete(pending.body.challenge, totp);
    assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.isRemoteLogin, true);
    assert.equal(accepted.body.role, null, "home admin gains no admin rights on the visited node");
    const session = responseSession(accepted.response, accepted.body);
    assert.equal((await complete(pending.body.challenge, codes[0])).response.status, 401, "challenge is single-use");
    const local = await authRequest(a, "/login", { username: envA.username, password: envA.password });
    assert.equal((await authRequest(a, "/login/mfa", { challenge: local.body.challenge, code: totp })).response.status, 401, "TOTP used remotely cannot replay at home");
    const recovery = await login();
    assert.equal((await complete(recovery.body.challenge, codes[0])).response.status, 200);
    assert.equal((await authRequest(a, "/login/mfa", { challenge: local.body.challenge, code: codes[0] })).response.status, 401, "recovery codes are consumed globally");
    assert.equal(dbB.prepare("SELECT count(*) n FROM user_mfa").get()!.n, 0, "visitor stores no MFA secret");
    assert.equal(dbB.prepare("SELECT count(*) n FROM mfa_recovery_codes").get()!.n, 0, "visitor stores no recovery codes");
    const proof = dbB.prepare("SELECT proof FROM visitor_sign_in_proofs").get()!.proof;
    const accountId = accepted.body.accountId;
    assert.equal((await fetch(`${a.url}/api/cluster/v2/accounts/mfa`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId, proof, code: codes[1] }) })).status, 401, "unsigned callers cannot verify factors");
    assert.equal((await signedNodeRequest(envB, b, a, "POST", "/api/cluster/v2/accounts/mfa", { accountId, proof: "0".repeat(64), code: codes[1] })).status, 401, "peer identity alone is not password proof");
    // Real gateway requests use the same home authenticator, subject to the phone opt-out.
    assert.equal((await fetch(`${b.url}/api/relay/serving`, { method: "PUT", headers: { Cookie: sb.cookie, "X-CSRF-Token": sb.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, origin: `http://localhost:${b.port}`, environment: "test", requestsEnabled: true, maxMachines: 10, monthlyCapGb: 0, alertTopic: "" }) })).status, 204);
    const relays = await api<{ local: { name: string } }>(b, sb, "GET", "/relays");
    const host = `${relays.body.local.name}.localhost:${b.port}`;
    const phoneLogin = () => gatewayPost(b.port, host, "/login", { username: "ana", password: envA.password });
    await api(b, sb, "PUT", "/relays/settings", { otherUsersPhoneSignIn: false });
    assert.equal((await phoneLogin()).status, 401, "phone opt-out refuses visitors");
    assert.equal((await api(b, sb, "PUT", "/relays/settings", { otherUsersPhoneSignIn: true })).status, 200);
    const phone = await phoneLogin();
    assert.equal(phone.status, 200, JSON.stringify(phone.body));
    assert.equal(phone.body.remoteMfa, true);
    assert.equal(phone.cookie, undefined);
    const verifiedPhone = await gatewayPost(b.port, host, "/login/mfa", { challenge: phone.body.challenge, code: codes[2] });
    assert.equal(verifiedPhone.status, 200, JSON.stringify(verifiedPhone.body));
    assert.match(String(verifiedPhone.cookie), /__Host-/);
    const phoneBeforeOptOut = await phoneLogin();
    await api(b, sb, "PUT", "/relays/settings", { otherUsersPhoneSignIn: false });
    assert.equal((await gatewayPost(b.port, host, "/login/mfa", { challenge: phoneBeforeOptOut.body.challenge, code: codes[3] })).status, 403, "opting out while MFA is pending prevents session delivery");
    dbA.prepare("DELETE FROM login_attempts WHERE username LIKE 'mfa:%'").run();
    for (let i = 0; i < 5; i++) {
      const attempt = await login();
      assert.equal((await complete(attempt.body.challenge, "invalid")).response.status, 401);
    }
    const limited = await login();
    assert.equal((await complete(limited.body.challenge, codes[1])).response.status, 429, "fresh password challenges cannot reset the home MFA budget");
    assert.equal((await authRequest(a, "/login", { username: envA.username, password: envA.password })).response.status, 429, "home sign-in shares the factor failure budget");
    dbA.prepare("DELETE FROM login_attempts WHERE username LIKE 'mfa:%'").run();
    const offline = await login();
    await stopDevNode(home);
    const unavailable = await complete(offline.body.challenge, codes[1]);
    assert.equal(unavailable.response.status, 503, JSON.stringify(unavailable.body));
    assert.equal(unavailable.response.headers.get("set-cookie"), null, "home outage never bypasses MFA");
    home = await startDevNode(envA, a);
    const restored = await complete(offline.body.challenge, codes[1]);
    assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
    const beforeBlock = await login();
    assert.equal((await api(b, sb, "PUT", `/node-blocks/${a.nodeId}`, { blocked: true })).status, 200);
    assert.equal((await complete(beforeBlock.body.challenge, codes[2])).response.status, 401, "blocking removes pending sign-ins");
    assert.equal((await authRequest(b, "/status", undefined, session)).body.authenticated, false, "blocking signs visitors out");
  } finally {
    dbA.close(); dbB.close();
    await stopDevNode(home); await stopDevNode(visitor);
    await rm(root, { recursive: true, force: true });
  }
});
