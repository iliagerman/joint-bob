import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import https from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function withDataDir(run: () => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-review-delivery-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** A real P-256 key pair, because web-push encrypts the payload before it ever sends. */
function deviceKeys(): { p256dh: string; auth: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
}

/** web-push always speaks HTTPS, so the stand-in push service needs a throwaway certificate.
    It is generated per run into a temporary directory and never leaves it. */
async function loopbackPushService(): Promise<{ url: string; requests: number; close: () => Promise<void> }> {
  const certDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-push-cert-"));
  const keyPath = path.join(certDir, "key.pem");
  const certPath = path.join(certDir, "cert.pem");
  await new Promise<void>((resolve, reject) => {
    execFile("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1", "-nodes",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
      "-keyout", keyPath, "-out", certPath], (error) => error ? reject(error) : resolve());
  });
  const state = { requests: 0 };
  const server = https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (_request, response) => {
    state.requests += 1;
    response.writeHead(201).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `https://127.0.0.1:${port}/device`,
    get requests() { return state.requests; },
    close: async () => {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
      await rm(certDir, { recursive: true, force: true });
    },
  };
}

test("a review notification reports whether a device was actually reached", async () => {
  await withDataDir(async () => {
    const push = await import(new URL(`../src/push.ts?delivery=${Date.now()}`, import.meta.url).href);

    // Nobody subscribed on this node: nothing was delivered, and the caller must be told.
    assert.equal(await push.notifyConversationReview("user-a", "project", "session", "Conversation"), false);

    // A subscription whose push service cannot be reached is also not a delivery.
    await push.savePushSubscription({ endpoint: "http://127.0.0.1:1/unreachable", keys: deviceKeys() }, "user-a", "*", "*", "Joint Bob");
    assert.equal(await push.notifyConversationReview("user-a", "project", "session", "Conversation"), false);

    // A push service that accepts the send is a delivery.
    const service = await loopbackPushService();
    const strictTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    // The fixture certificate is self-signed; nothing outside this assertion relaxes TLS.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      await push.savePushSubscription({ endpoint: service.url, keys: deviceKeys() }, "user-b", "*", "*", "Joint Bob");
      assert.equal(await push.notifyConversationReview("user-b", "project", "session", "Conversation"), true);
      assert.equal(service.requests, 1);
    } finally {
      if (strictTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = strictTls;
      await service.close();
    }
  });
});

test("releasing a claim re-arms the notification for the next sweep", async () => {
  await withDataDir(async () => {
    const reviews = await import(new URL(`../src/conversation-reviews.ts?release=${Date.now()}`, import.meta.url).href);

    reviews.syncConversationReviewStates("user-a", "user-a-name", "project", [{ path: "session", engine: "pi" as const, sessionId: "session", updatedAt: "2026-01-01T00:00:00.000Z", running: false }]);
    reviews.syncConversationReviewStates("user-a", "user-a-name", "project", [{ path: "session", engine: "pi" as const, sessionId: "session", updatedAt: "2026-01-01T00:01:00.000Z", running: false }]);
    reviews.setConversationReviewNotifications("user-a", "project", "session", true);

    assert.deepEqual(reviews.claimReviewNotifications("user-a", "project", ["session"]), ["session"]);
    assert.deepEqual(reviews.claimReviewNotifications("user-a", "project", ["session"]), []);

    // The send failed, so the claim must go back: the phone has not been told yet.
    reviews.releaseReviewNotification("user-a", "project", "session");
    assert.deepEqual(reviews.claimReviewNotifications("user-a", "project", ["session"]), ["session"]);
  });
});
