import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { authRequest, fixtureDatabase, fixtureTotp, responseSession } from "./mfa-fixture.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-mfa-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  let server: ChildProcess;
  try { server = await startDevNode(environment, node); }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  const session = await signIn(environment, node);
  const db = fixtureDatabase(node);
  const request = (endpoint: string, body?: unknown) => authRequest(node, endpoint, body, session);
  const login = () => authRequest(node, "/login", { username: environment.username, password: environment.password });
  const enroll = async () => {
    const setup = await request("/mfa/setup", { currentPassword: environment.password });
    assert.equal(setup.response.status, 200, "authenticated users can start their own MFA setup");
    const enrollmentCode = fixtureTotp(setup.body.secret);
    const confirmed = await request("/mfa/confirm", { code: enrollmentCode });
    assert.equal(confirmed.response.status, 200, "MFA activates only after proving the setup key");
    return { secret: setup.body.secret as string, codes: confirmed.body.recoveryCodes as string[], enrollmentCode };
  };
  return { environment, node, session, db, request, login, enroll,
    async restart() { await stopDevNode(server); server = await startDevNode(environment, node); },
    async close() { db.close(); await stopDevNode(server); await rm(root, { recursive: true, force: true }); },
  };
}

function socketClosed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Socket was not revoked")); }, 10_000);
    socket.once("error", reject);
    socket.once("close", (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }); });
  });
}

test("MFA enrollment requires password, CSRF, a live session-bound setup, and proof; storage never keeps plaintext", { timeout: 90_000 }, async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.request("/mfa")).body, { enabled: false, recoveryCodesRemaining: 0 });
    assert.equal((await authRequest(f.node, "/mfa/setup", { currentPassword: f.environment.password })).response.status, 401);
    assert.equal((await authRequest(f.node, "/mfa/setup", { currentPassword: f.environment.password }, { ...f.session, csrfToken: "wrong" })).response.status, 403);
    assert.equal((await f.request("/mfa/setup", { currentPassword: "wrong" })).response.status, 400);
    const setup = await f.request("/mfa/setup", { currentPassword: f.environment.password });
    assert.equal(setup.response.status, 200);
    assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
    const uri = new URL(setup.body.otpauthUri);
    assert.equal(uri.protocol, "otpauth:");
    assert.equal(uri.searchParams.get("secret"), setup.body.secret);
    assert.equal(uri.searchParams.get("issuer"), "Joint Bob");
    assert.equal((await f.request("/mfa")).body.enabled, false, "starting setup must not lock out the user");
    assert.equal((await f.login()).body.mfaRequired, undefined, "unconfirmed setup leaves password login working");
    assert.equal((await f.request("/mfa/confirm", { code: "bad-code" })).response.status, 400);
    const otherSession = await signIn(f.environment, f.node);
    assert.equal((await authRequest(f.node, "/mfa/confirm", { code: fixtureTotp(setup.body.secret) }, otherSession)).response.status, 400, "another session cannot finish this setup");
    f.db.exec("UPDATE mfa_enrollments SET expires_at = '2000-01-01T00:00:00.000Z'");
    assert.equal((await f.request("/mfa/confirm", { code: fixtureTotp(setup.body.secret) })).response.status, 400, "expired setup cannot activate MFA");
    const { secret, codes } = await f.enroll();
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    assert.deepEqual((await f.request("/mfa")).body, { enabled: true, recoveryCodesRemaining: 10 });
    assert.equal((await f.request("/mfa/setup", { currentPassword: f.environment.password })).response.status, 409);
    const stored = JSON.stringify({ factors: f.db.prepare("SELECT * FROM user_mfa").all(), recovery: f.db.prepare("SELECT * FROM mfa_recovery_codes").all(), audit: f.db.prepare("SELECT * FROM audit_events").all() });
    assert.ok(!stored.includes(secret), "setup key must be encrypted at rest and absent from audit");
    for (const code of codes) assert.ok(!stored.includes(code) && !stored.includes(code.replaceAll("-", "")), "recovery codes must be hashed, not stored or audited verbatim");
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM mfa_enrollments").get()!.n, 0);
    assert.equal((await authRequest(f.node, "/sessions", undefined, otherSession)).response.status, 401, "enrollment revokes pre-MFA sessions");
  } finally { await f.close(); }
});

test("MFA login gates HTTP and WebSockets, rejects expired/replayed proofs, and survives restart", { timeout: 90_000 }, async () => {
  const f = await fixture();
  try {
    const { secret, codes, enrollmentCode } = await f.enroll();
    const pending = await f.login();
    assert.equal(pending.response.status, 200);
    assert.equal(pending.body.mfaRequired, true);
    assert.equal(pending.body.csrfToken, undefined);
    assert.equal(pending.response.headers.get("set-cookie"), null, "password alone must never issue a session");
    assert.deepEqual((await authRequest(f.node, "/status", undefined, { cookie: `${f.node.cookieName}=${pending.body.challenge}`, csrfToken: "" })).body, { authenticated: false, setupRequired: false });
    const socket = new WebSocket(`${f.node.url.replace("http:", "ws:")}/ws?projectId=${f.node.projects[0].id}&sessionPath=watch`, { headers: { Cookie: `${f.node.cookieName}=${pending.body.challenge}`, Origin: f.node.url } });
    assert.equal((await socketClosed(socket)).code, 1008, "pending MFA cannot open a watch socket");
    assert.equal((await authRequest(f.node, "/login/mfa", { challenge: pending.body.challenge, code: "not-a-code" })).response.status, 401);
    assert.equal((await authRequest(f.node, "/login/mfa", { challenge: pending.body.challenge, code: enrollmentCode })).response.status, 401, "enrollment code is already consumed");
    const loginCode = fixtureTotp(secret, 1);
    const completed = await authRequest(f.node, "/login/mfa", { challenge: pending.body.challenge, code: loginCode });
    assert.equal(completed.response.status, 200);
    assert.ok(completed.body.csrfToken);
    assert.match(completed.response.headers.get("set-cookie")!, /HttpOnly;.*SameSite=Strict/);
    const signedIn = responseSession(completed.response, completed.body);
    assert.equal((await authRequest(f.node, "/sessions", undefined, signedIn)).response.status, 200);
    assert.equal((await authRequest(f.node, "/login/mfa", { challenge: pending.body.challenge, code: codes[0] })).response.status, 401, "challenge is single-use");
    const replay = await f.login();
    assert.equal((await authRequest(f.node, "/login/mfa", { challenge: replay.body.challenge, code: loginCode })).response.status, 401, "TOTP cannot be replayed through a new challenge");
    f.db.exec("UPDATE mfa_login_challenges SET expires_at = '2000-01-01T00:00:00.000Z'");
    assert.equal((await authRequest(f.node, "/login/mfa", { challenge: replay.body.challenge, code: codes[0] })).response.status, 401);
    await f.restart();
    const recovery = await f.login();
    assert.equal(recovery.body.mfaRequired, true);
    const attempts = await Promise.all([0, 1].map(() => authRequest(f.node, "/login/mfa", { challenge: recovery.body.challenge, code: codes[0].toUpperCase() })));
    assert.deepEqual(attempts.map(result => result.response.status).sort(), [200, 401], "concurrent recovery completes only once");
    const again = await f.login();
    assert.equal((await authRequest(f.node, "/login/mfa", { challenge: again.body.challenge, code: codes[0] })).response.status, 401);
    assert.equal((await f.request("/mfa")).body.recoveryCodesRemaining, 9);
    assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM mfa_login_challenges").all()).includes(again.body.challenge), "challenge bearer is hashed at rest");
  } finally { await f.close(); }
});

test("MFA failures stay rate-limited across new password logins and restarts", { timeout: 90_000 }, async () => {
  const f = await fixture();
  try {
    const { codes } = await f.enroll();
    let challenge = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const login = await f.login();
      assert.equal(login.response.status, 200);
      challenge = login.body.challenge;
      assert.equal((await authRequest(f.node, "/login/mfa", { challenge, code: "bad-code" })).response.status, 401);
    }
    assert.equal((await f.login()).response.status, 429, "password success must not reset the second-factor failure budget");
    await f.restart();
    assert.equal((await authRequest(f.node, "/login/mfa", { challenge, code: codes[0] })).response.status, 429);
    assert.equal((await f.request("/mfa/disable", { currentPassword: f.environment.password, code: codes[0] })).response.status, 429, "management cannot bypass the failure budget");
    f.db.exec("UPDATE login_attempts SET attempted_at = '2000-01-01T00:00:00.000Z'");
    assert.equal((await authRequest(f.node, "/login/mfa", { challenge, code: codes[0] })).response.status, 200);
  } finally { await f.close(); }
});

test("MFA management requires both factors, rotates recovery codes and revokes sessions including open sockets", { timeout: 90_000 }, async () => {
  const f = await fixture();
  let socket: WebSocket | undefined;
  try {
    const oldSession = await signIn(f.environment, f.node);
    socket = new WebSocket(`${f.node.url.replace("http:", "ws:")}/ws?projectId=${f.node.projects[0].id}&sessionPath=watch`, { headers: { Cookie: oldSession.cookie, Origin: f.node.url } });
    await new Promise<void>((resolve, reject) => { socket!.once("message", () => resolve()); socket!.once("error", reject); });
    const closed = socketClosed(socket);
    const { codes } = await f.enroll();
    assert.equal((await closed).code, 1008, "enabling MFA must close old authenticated sockets");
    assert.equal((await f.request("/mfa/disable", { currentPassword: f.environment.password })).response.status, 400);
    assert.equal((await f.request("/mfa/disable", { currentPassword: "wrong", code: codes[0] })).response.status, 400);
    assert.equal((await f.request("/mfa/disable", { currentPassword: f.environment.password, code: "bad-code" })).response.status, 400);
    const pending = await f.login();
    const rotated = await f.request("/mfa/recovery-codes", { currentPassword: f.environment.password, code: codes[0] });
    assert.equal(rotated.response.status, 200);
    assert.equal(rotated.body.recoveryCodes.length, 10);
    assert.equal((await authRequest(f.node, "/login/mfa", { challenge: pending.body.challenge, code: rotated.body.recoveryCodes[0] })).response.status, 401, "security changes invalidate unfinished logins");
    const login = await f.login();
    assert.equal((await authRequest(f.node, "/login/mfa", { challenge: login.body.challenge, code: codes[1] })).response.status, 401, "old recovery set is invalidated");
    const completed = await authRequest(f.node, "/login/mfa", { challenge: login.body.challenge, code: rotated.body.recoveryCodes[0] });
    assert.equal(completed.response.status, 200);
    assert.equal((await f.request("/mfa/disable", { currentPassword: f.environment.password, code: rotated.body.recoveryCodes[1] })).response.status, 200);
    assert.deepEqual((await f.request("/mfa")).body, { enabled: false, recoveryCodesRemaining: 0 });
    assert.equal((await authRequest(f.node, "/sessions", undefined, responseSession(completed.response, completed.body))).response.status, 401);
    assert.equal((await f.login()).body.mfaRequired, undefined, "password-only login resumes after explicit disable");
  } finally { socket?.terminate(); await f.close(); }
});

test("MFA belongs to the authenticated user; cancelling setup and password changes discard unfinished proofs", { timeout: 90_000 }, async () => {
  const f = await fixture();
  try {
    const setup = await f.request("/mfa/setup", { currentPassword: f.environment.password });
    assert.equal(setup.response.status, 200);
    assert.equal((await authRequest(f.node, "/mfa/setup", undefined, f.session, "DELETE")).response.status, 204);
    assert.equal((await f.request("/mfa/confirm", { code: fixtureTotp(setup.body.secret) })).response.status, 400);
    const { codes } = await f.enroll();
    f.db.prepare("INSERT INTO users SELECT 'other-user', 'other-user', password_hash, password_salt, 0, created_at, updated_at FROM users LIMIT 1").run();
    const otherLogin = await authRequest(f.node, "/login", { username: "other-user", password: f.environment.password });
    assert.equal(otherLogin.body.mfaRequired, undefined);
    const other = responseSession(otherLogin.response, otherLogin.body);
    assert.deepEqual((await authRequest(f.node, "/mfa", undefined, other)).body, { enabled: false, recoveryCodesRemaining: 0 });
    assert.equal((await authRequest(f.node, "/mfa/disable", { currentPassword: f.environment.password, code: codes[0] }, other)).response.status, 409);
    assert.equal((await f.request("/mfa")).body.enabled, true);
    const pending = await f.login();
    assert.equal((await f.request("/change-password", { currentPassword: f.environment.password, newPassword: "a-new-synthetic-password" })).response.status, 204);
    assert.equal((await authRequest(f.node, "/login/mfa", { challenge: pending.body.challenge, code: codes[0] })).response.status, 401, "old password proof cannot survive password change");
    assert.equal((await f.request("/mfa")).body.enabled, true, "changing password must not remove MFA");
  } finally { await f.close(); }
});
