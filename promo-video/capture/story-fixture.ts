// The story and the podcast the story film shows, about the double-charge fix (PR #212) the other
// films follow. In a real node a writer model makes these; the capture hands them to the page
// through the same routes, so the real Story view and Activity overview player draw them.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const storyFacts = {
  conversation: true,
  turns: [
    { n: 1, at: new Date(Date.now() - 3 * 3_600_000).toISOString(), user: "Payment retries double-charge customers when the provider times out. Find the cause and fix it.", commits: [], paths: ["src/payments/retry.ts", "test/payments/retry.test.ts"] },
    { n: 2, at: new Date(Date.now() - 2 * 3_600_000).toISOString(), user: "Ship the fix and open a PR.", commits: ["9c41e2a"], paths: ["src/payments/retry.ts", "src/orders/order.ts"] },
  ],
  commits: [{ hash: "9c41e2a7b1d04f5e8a2c6b3d9e0f1a2b3c4d5e6f", shortHash: "9c41e2a", subject: "fix(payments): reuse the idempotency key across retries", turn: 2 }],
  files: [
    { path: "src/payments/retry.ts", kind: "modified", add: 4, del: 2, where: ["9c41e2a"], area: "payments" },
    { path: "src/orders/order.ts", kind: "modified", add: 3, del: 0, where: ["9c41e2a"], area: "orders" },
    { path: "test/payments/retry.test.ts", kind: "modified", add: 18, del: 0, where: ["9c41e2a"], area: "tests" },
  ],
};

export const storyWritten = {
  kind: "Bug fix",
  title: "One idempotency key per order",
  overview: {
    what: "A payment retry now sends the same idempotency key as the first attempt.",
    why: "When the provider timed out but still charged the card, the retry looked like a new payment and charged it again.",
    notice: ["A retry after a timeout no longer charges twice.", "Orders store their payment key."],
    unchanged: "Unchanged: the retry limit and the provider client.",
  },
  diagram: {
    lanes: [{ id: "shop", label: "Checkout" }, { id: "provider", label: "Payment provider" }],
    nodes: [
      { id: "pay", lane: "shop", kind: "action", label: "Charge the card", sub: "attempt 1", text: "Checkout sends the charge with the order's key.", files: ["src/payments/retry.ts"] },
      { id: "timeout", lane: "provider", kind: "decision", label: "Timed out?", sub: "", text: "The provider is slow to answer.", files: [] },
      { id: "retry", lane: "shop", kind: "action", label: "Retry, same key", sub: "attempt 2", text: "The retry reuses the order's key.", files: ["src/payments/retry.ts", "src/orders/order.ts"] },
      { id: "once", lane: "provider", kind: "action", label: "Charged once", sub: "", text: "The provider sees the same key and does not charge again.", files: [] },
    ],
    edges: [
      { from: "pay", to: "timeout", label: "", style: "solid" },
      { from: "timeout", to: "retry", label: "yes", style: "solid" },
      { from: "retry", to: "once", label: "same key", style: "solid" },
    ],
  },
  timeline: [
    { turns: [1], title: "Found the cause", did: ["Traced the retry path.", "Wrote a failing test."], decided: ["Key per order, not per attempt."], pivot: "", quiet: false },
    { turns: [2], title: "Shipped the fix", did: ["Stored the key on the order.", "Opened PR #212."], decided: [], pivot: "", quiet: false },
  ],
  examples: [
    { kind: "Failure, now handled", title: "The provider times out", start: "A customer pays for order 4410.", steps: [
      { you: "Pay.", app: "Sends the charge with the order's key.", says: "", nodes: ["pay", "timeout"], edges: ["pay>timeout"] },
      { you: "", app: "Retries with the same key.", says: "Payment received", nodes: ["timeout", "retry", "once"], edges: ["timeout>retry", "retry>once"] },
    ], result: "The card is charged once." },
  ],
  implementation: {
    what: { "src/payments/retry.ts": "Uses the order's payment key on every attempt.", "src/orders/order.ts": "Creates the key once, when the order is created.", "test/payments/retry.test.ts": "Covers a timeout followed by a retry." },
    decisions: [{ title: "Key on the order", why: "The order outlives every attempt.", instead: "A key per attempt.", turn: 1 }],
    checks: [{ priority: "high", text: "Orders created before the fix get a key on first retry.", file: "src/orders/order.ts" }],
    tests: [{ file: "test/payments/retry.test.ts", name: "reuses the idempotency key after a timeout" }],
  },
};

export const storyPatches = [
  { path: "src/payments/retry.ts", source: "9c41e2a", patch: "diff --git a/src/payments/retry.ts b/src/payments/retry.ts\n--- a/src/payments/retry.ts\n+++ b/src/payments/retry.ts\n@@ -24,6 +24,6 @@\n   const response = await client.charge({\n     amount: order.total,\n-    idempotencyKey: newKey(),\n+    idempotencyKey: order.paymentKey,\n   });" },
  { path: "src/orders/order.ts", source: "9c41e2a", patch: "diff --git a/src/orders/order.ts b/src/orders/order.ts\n--- a/src/orders/order.ts\n+++ b/src/orders/order.ts\n@@ -12,3 +12,6 @@\n   const order = { id, items, total };\n+  // One key for every attempt to pay for this order.\n+  order.paymentKey = randomUUID();\n   return order;" },
];

const recap = [["What changed", "Retries reuse the order's key."], ["Why", "Timeouts charged twice."], ["What we give up", "Nothing."], ["How you notice", "One charge per order."]].map(([label, text]) => ({ label, text }));

export const podcastScript = {
  title: "One idempotency key per order",
  chapters: [
    { title: "The double charge", location: "server", mood: "tension", visual: { kind: "flow", nodes: [{ label: "Charge", sub: "attempt 1", tone: "neutral" }, { label: "Timeout", sub: "", tone: "bad" }, { label: "Charge again", sub: "new key", tone: "bad" }], note: { title: "Result", text: "The card is charged twice." } },
      lines: [
        { who: "host", text: "Some customers were charged twice for one order.", reveal: 1 },
        { who: "cohost", text: "Twice? How does that even happen?", reveal: 2 },
        { who: "host", text: "The provider timed out, but still took the money. Then we retried.", reveal: 3 },
      ] },
    { title: "The fix", location: "matrix", mood: "insight", visual: { kind: "code", file: "src/payments/retry.ts", lines: ["-    idempotencyKey: newKey(),", "+    idempotencyKey: order.paymentKey,"], steps: [{ from: 1, to: 1, note: "A new key on every attempt." }, { from: 2, to: 2, note: "The order's key, every time." }] },
      lines: [
        { who: "host", text: "Every retry made a brand new key.", reveal: 1 },
        { who: "host", text: "Now the key lives on the order, so a retry looks like the same payment.", reveal: 2 },
      ] },
    { title: "Recap", location: "rooftop", mood: "resolved", visual: { kind: "recap", items: recap },
      lines: [
        { who: "cohost", text: "So one order, one charge. Even when the provider is slow.", reveal: 2 },
        { who: "host", text: "Exactly. And a test keeps it that way.", reveal: 4 },
      ] },
  ],
  writeup: { changed: ["Retries reuse the order's payment key."], how: ["The key is created with the order and sent on every attempt."], why: ["A timeout followed by a retry charged twice."], rejected: [{ option: "A key per attempt", why: "The provider sees each retry as a new payment." }], limits: ["Older orders get a key on their first retry."] },
  followUps: [] as Array<{ question: string; answer: string }>,
  generatedAt: new Date().toISOString(),
};

export const followUpQuestion = "What about orders created before the fix?";
export const followUpChapter = {
  title: "Older orders", location: "coffeehouse", mood: "calm", question: followUpQuestion,
  visual: { kind: "compare", options: [{ title: "Key on first retry", why: "Old orders are covered too.", verdict: "yes" }, { title: "Backfill every order", why: "A migration for no gain.", verdict: "no" }] },
  lines: [
    { who: "cohost", text: "What about orders created before the fix?", reveal: 1 },
    { who: "host", text: "They get a key on their first retry, so they are covered too.", reveal: 2 },
  ],
};

export const podcastWithAnswer = { ...podcastScript, chapters: [...podcastScript.chapters, followUpChapter], followUps: [{ question: followUpQuestion, answer: "Older orders get a key the first time they are retried." }] };

/** Every spoken line, in the order the player speaks it, with its file name in public/audio. */
export function spokenLines(): Array<{ name: string; who: "host" | "cohost"; text: string }> {
  return podcastWithAnswer.chapters.flatMap((chapter) => chapter.lines).map((line, index) => ({ name: `story-line-${String(index + 1).padStart(2, "0")}`, who: line.who as "host" | "cohost", text: line.text }));
}

// Maya explains, Jonah asks; the same Kokoro voices the app's Activity overview defaults to.
export const VOICES = { host: "af_heart", cohost: "am_michael" };

/**
 * Speaks each line with the open-source Kokoro voice Joint Bob installs (Settings → Activity
 * overview), into public/audio, so the page plays the real voices and the film can lay the same
 * files on its soundtrack. Lines already spoken are kept.
 */
export async function speakStoryLines(audioDir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const lines = spokenLines();
  const missing = [];
  for (const line of lines) {
    const file = path.join(audioDir, `${line.name}.mp3`);
    const ok = await stat(file).then((info) => info.size > 0, () => false);
    if (ok) files.set(line.text, await readFile(file)); else missing.push(line);
  }
  if (missing.length) {
    const data = process.env.JOINT_BOB_VOICE_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
    const { KokoroTTS, env, Mp3Encoder } = await import(pathToFileURL(path.join(data, "story-voice-runtime/load.mjs")).href);
    const { toMp3 } = await import("../../src/server/story-voice.js");
    env.cacheDir = path.join(data, "kokoro-models");
    const engine = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
    await mkdir(audioDir, { recursive: true });
    for (const line of missing) {
      const audio = await engine.generate(line.text, { voice: VOICES[line.who], speed: 1 });
      const bytes = toMp3(audio.audio, audio.sampling_rate, Mp3Encoder);
      await writeFile(path.join(audioDir, `${line.name}.mp3`), bytes);
      files.set(line.text, bytes);
    }
  }
  return files;
}
