import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// The click-through link comes from the cluster node URL, which is seeded from this
// variable on first boot; it must be set before the push module (and cluster) load.
process.env.JOINT_BOB_NODE_URL = "https://node.example.test";

interface ReceivedPublish {
  url: string;
  authorization: string | undefined;
  body: { topic: string; title: string; message: string; click?: string };
}

async function withNtfyServer(status: number, run: (origin: string, received: ReceivedPublish[]) => Promise<void>): Promise<void> {
  const received: ReceivedPublish[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(status, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("ntfy stand-in did not bind");
  try {
    await run(`http://127.0.0.1:${address.port}`, received);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withPushStore(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ntfy-delivery-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    await run(dataDir);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("a review notification publishes the preview to the conversation's ntfy topic", async () => {
  await withPushStore(async () => {
    await withNtfyServer(200, async (origin, received) => {
      const push = await import(new URL(`../src/push.ts?ntfy-ok=${Date.now()}`, import.meta.url).href);
      const subscription = push.ntfySubscription(origin, "my-reviews", "tk_secret", "project-a", "watch");
      await push.savePushSubscription(subscription, "user-a", "project-a", "watch", "My chat");
      const delivered = await push.notifyConversationReview("user-a", "project-a", "watch", "My chat", "All tests pass now.");
      assert.equal(delivered, true);
      assert.equal(received.length, 1);
      assert.equal(received[0].url, "/", "JSON publishing posts to the server root");
      assert.equal(received[0].authorization, "Bearer tk_secret");
      assert.equal(received[0].body.topic, "my-reviews");
      assert.equal(received[0].body.title, "My chat needs review");
      assert.equal(received[0].body.message, "All tests pass now.");
      assert.equal(received[0].body.click, "https://node.example.test/?projectId=project-a&sessionPath=watch");
    });
  });
});

test("a tokenless ntfy service publishes without an Authorization header", async () => {
  await withPushStore(async () => {
    await withNtfyServer(200, async (origin, received) => {
      const push = await import(new URL(`../src/push.ts?ntfy-anon=${Date.now()}`, import.meta.url).href);
      const subscription = push.ntfySubscription(origin, "open-topic", "", "project-b", "watch");
      await push.savePushSubscription(subscription, "user-a", "project-b", "watch", "Open chat");
      const delivered = await push.notifyConversationReview("user-a", "project-b", "watch", "Open chat", "Done.");
      assert.equal(delivered, true);
      assert.equal(received[0].authorization, undefined);
    });
  });
});

test("a rejected ntfy publish reports failure and keeps the subscription for retry", async () => {
  await withPushStore(async (dataDir) => {
    await withNtfyServer(500, async (origin) => {
      const push = await import(new URL(`../src/push.ts?ntfy-fail=${Date.now()}`, import.meta.url).href);
      const subscription = push.ntfySubscription(origin, "my-reviews", "tk_secret", "project-c", "watch");
      await push.savePushSubscription(subscription, "user-a", "project-c", "watch", "My chat");
      const delivered = await push.notifyConversationReview("user-a", "project-c", "watch", "My chat", "Body.");
      assert.equal(delivered, false);
      const db = new DatabaseSync(path.join(dataDir, "node.db"), { readOnly: true });
      const row = db.prepare("SELECT COUNT(*) AS count FROM push_session_subscriptions WHERE project_id = 'project-c'").get() as { count: number };
      db.close();
      assert.equal(row.count, 1, "a server error must not delete the target like a dead web-push endpoint");
    });
  });
});

test("conversations publishing to the same topic keep distinct endpoints so one can opt out alone", async () => {
  await withPushStore(async () => {
    const push = await import(new URL(`../src/push.ts?ntfy-distinct=${Date.now()}`, import.meta.url).href);
    const first = push.ntfySubscription("https://ntfy.example", "shared", "tk", "project", "session-one");
    const second = push.ntfySubscription("https://ntfy.example", "shared", "tk", "project", "session-two");
    assert.notEqual(first.endpoint, second.endpoint);
    assert.ok(first.endpoint.startsWith("ntfy+https://ntfy.example/shared#"));
  });
});
