import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Syncthing rewrites a transcript's mtime whenever a peer advertises new metadata, so a
// synchronized conversation looks freshly active without carrying a single new message.
// Recency therefore comes from the newest event inside the transcript, not from the file clock.
test("Claude conversation recency comes from transcript events, not the file mtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-recency-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = root;
  try {
    const sessionRoot = path.join(root, "claude-sessions");
    const projectCwd = path.join(root, "project");
    await mkdir(projectCwd, { recursive: true });

    const settings = await import(`../src/settings.js?cache=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      pi: { executable: "pi", configPath: path.join(root, "pi-config"), sessionPath: path.join(root, "pi-sessions") },
      claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: sessionRoot },
      syncthing: { endpoint: "" },
    });

    const sessionPaths = await import(`../src/session-paths.js?cache=${Date.now()}-${Math.random()}`);
    const claude = await import(`../src/claude-service.js?cache=${Date.now()}-${Math.random()}`);
    const projectDir = sessionPaths.claudeProjectDir(projectCwd, sessionRoot);
    await mkdir(projectDir, { recursive: true });

    const user = (text: string, timestamp?: string) => ({
      type: "user",
      cwd: projectCwd,
      ...(timestamp ? { timestamp } : {}),
      message: { role: "user", content: [{ text }] },
    });
    const write = async (file: string, records: unknown[], mtime: Date): Promise<string> => {
      const filePath = path.join(projectDir, file);
      await writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n"));
      await utimes(filePath, mtime, mtime);
      return filePath;
    };

    // A transcript whose last message landed at 11:59 but whose file clock was pushed to 17:03.
    const synchronized = await write("synchronized.jsonl", [
      user("First", "2026-08-29T11:59:10.000Z"),
      user("Last real message", "2026-08-29T11:59:14.394Z"),
      // Claude appends these trailing records without a timestamp of their own.
      { type: "last-prompt", lastPrompt: "Last real message", sessionId: "synchronized" },
      { type: "cost-state", sessionId: "synchronized", totalCostUSD: 1.5 },
    ], new Date("2026-08-29T17:03:06.949Z"));

    // Timestamps can arrive out of order, so the newest one wins rather than the last line.
    const outOfOrder = await write("out-of-order.jsonl", [
      user("Newest", "2026-08-29T09:00:00.000Z"),
      user("Older", "2026-08-29T08:00:00.000Z"),
    ], new Date("2026-08-29T17:03:06.949Z"));

    // Nothing inside carries a timestamp, so the file clock is the only answer available.
    const undated = await write("undated.jsonl", [user("No timestamp")], new Date("2026-08-29T17:03:06.949Z"));

    const sessions = await claude.listClaudeSessions({ path: projectCwd });
    const byPath = new Map(sessions.map((session: { path: string; updatedAt?: string }) => [session.path, session.updatedAt]));

    assert.equal(byPath.get(`claude:${synchronized}`), "2026-08-29T11:59:14.394Z");
    assert.equal(byPath.get(`claude:${outOfOrder}`), "2026-08-29T09:00:00.000Z");
    assert.equal(byPath.get(`claude:${undated}`), "2026-08-29T17:03:06.949Z");
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});

// A watermark inflated by a phantom mtime used to stick forever, because the stored activity
// time only ever moved forward. Reported activity is now authoritative in both directions.
test("conversation review state follows reported activity downwards", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-review-heal-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const reviews = await import(`../src/conversation-reviews.ts?test=${Date.now()}-${Math.random()}`);
    const session = { path: "synchronized", running: false };

    reviews.syncConversationReviewStates("user-a", "project", [{ ...session, updatedAt: "2026-08-29T11:00:00.000Z" }]);
    reviews.markConversationReviewed("user-a", "project", { path: session.path, updatedAt: "2026-08-29T11:00:00.000Z" });

    // A phantom mtime bump inflates the stored activity time.
    const inflated = reviews.syncConversationReviewStates("user-a", "project", [{ ...session, updatedAt: "2026-08-29T17:03:06.949Z" }]);
    assert.equal(inflated.get(session.path), "needs_review");

    // Reading recency from the transcript reports the real time again, which clears the alert.
    const healed = reviews.syncConversationReviewStates("user-a", "project", [{ ...session, updatedAt: "2026-08-29T11:00:00.000Z" }]);
    assert.equal(healed.get(session.path), "reviewed");
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});
