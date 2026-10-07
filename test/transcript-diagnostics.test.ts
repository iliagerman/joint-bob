import assert from "node:assert/strict";
import test from "node:test";

type Entry = { index: number; role: string; length: number; indexBefore?: number; lengthBefore?: number };
type Logged = { messagesBefore: number; messagesAfter: number; removed: Entry[]; added: Entry[]; changed: Entry[] };

const { logTranscriptChanges } = await import("../public/app/transcript-diagnostics.js") as { logTranscriptChanges: (key: string, messages: Array<{ id: string; role: string; text: string }>, source: string) => void };

function capture(run: () => void): Logged[] {
  const logged: Logged[] = [];
  const original = console.info;
  console.info = (_label: string, fields: Logged) => { logged.push(fields); };
  try { run(); } finally { console.info = original; }
  return logged;
}

// Positional ids, as the Claude parser assigns them.
const transcript = (texts: string[]) => texts.map((text, index) => ({ id: String(index), role: index % 2 ? "assistant" : "user", text }));

test("the first load records without logging, and an identical reload stays quiet", () => {
  const logged = capture(() => {
    logTranscriptChanges("quiet", transcript(["a", "b", "c"]), "open");
    logTranscriptChanges("quiet", transcript(["a", "b", "c"]), "reconnect");
  });
  assert.deepEqual(logged, []);
});

test("a message removed mid-transcript is named once, not as every later message renumbered", () => {
  const logged = capture(() => {
    logTranscriptChanges("middle", [{ id: "0", role: "user", text: "first" }, { id: "1", role: "assistant", text: "lost" }, { id: "2", role: "user", text: "third" }, { id: "3", role: "assistant", text: "fourth" }], "open");
    logTranscriptChanges("middle", [{ id: "0", role: "user", text: "first" }, { id: "1", role: "user", text: "third" }, { id: "2", role: "assistant", text: "fourth" }], "reconnect");
  });
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].removed.map((entry) => [entry.index, entry.role, entry.length]), [[1, "assistant", 4]]);
  assert.deepEqual(logged[0].added, []);
  assert.deepEqual(logged[0].changed, []);
});

test("a sliding message window reports the dropped oldest and the new newest", () => {
  const logged = capture(() => {
    const message = (text: string, index: number) => ({ id: String(index), role: Number(text[1]) % 2 ? "assistant" : "user", text });
    logTranscriptChanges("window", ["m0", "m1", "m2", "m3", "m4"].map(message), "open");
    logTranscriptChanges("window", ["m1", "m2", "m3", "m4", "m5!"].map(message), "reconnect");
  });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].messagesBefore, 5);
  assert.equal(logged[0].messagesAfter, 5);
  assert.deepEqual(logged[0].changed, [], `a window slide is not a rewrite: ${JSON.stringify(logged[0])}`);
  assert.deepEqual(logged[0].removed.map((entry) => entry.index), [0]);
  assert.deepEqual(logged[0].added.map((entry) => [entry.index, entry.length]), [[4, 3]]);
});

test("a message rewritten in place is reported as changed with both lengths", () => {
  const logged = capture(() => {
    logTranscriptChanges("rewrite", transcript(["question", "a long streamed answer"]), "open");
    logTranscriptChanges("rewrite", transcript(["question", "short"]), "reconnect");
  });
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].changed.map((entry) => [entry.index, entry.indexBefore, entry.lengthBefore, entry.length]), [[1, 1, 22, 5]]);
  assert.deepEqual(logged[0].removed, []);
  assert.deepEqual(logged[0].added, []);
});
