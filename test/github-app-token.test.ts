import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { installationToken } from "../scripts/github-app-token.mjs";

test("GitHub App signs a short-lived JWT and exchanges it for an installation token", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const result = await installationToken({ appId: "123", installationId: "456", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, async (url, options) => {
    assert.equal(url, "https://api.github.com/app/installations/456/access_tokens");
    assert.equal(options.method, "POST");
    const jwt = options.headers.Authorization.replace("Bearer ", "");
    const [header, payload, signature] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    assert.equal(claims.iss, "123");
    assert.ok(claims.iat <= now && claims.iat >= now - 61);
    assert.ok(claims.exp <= now + 600 && claims.exp > now);
    assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")), true);
    return { ok: true, json: async () => ({ token: "synthetic-installation-token", expires_at: expiresAt }) };
  });
  assert.deepEqual(result, { token: "synthetic-installation-token", expiresAt: Date.parse(expiresAt) });
});

test("GitHub App token exchange fails without returning GitHub's response body", async () => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await assert.rejects(installationToken({ appId: "123", installationId: "456", privateKey }, async () => ({ ok: false, status: 403 })), /HTTP 403/);
});
