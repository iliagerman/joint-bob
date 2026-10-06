import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { temporaryRoot } from "./queued-prompt-harness.js";

const dana = { accountId: "d".repeat(32), email: "dana@example.test", username: "dana", homeNodeId: "node-h" };
const noam = { accountId: "e".repeat(32), email: "noam@example.test", username: "noam", homeNodeId: null };

test("authors match their messages by text and occurrence, and the tag the agent saw is not shown", async () => {
  const root = await temporaryRoot("joint-bob-authors-unit-");
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = root;
  try {
    const authors = await import(`../src/message-authors.ts?unit=${Date.now()}`) as typeof import("../src/message-authors.js");
    assert.equal(authors.authoredPromptText("p", "c", "hello", dana), "hello", "a lone author is not tagged");
    authors.recordMessageAuthor("p", "c", "hello", dana, "node-a");
    assert.equal(authors.authoredPromptText("p", "c", "again", dana), "again", "still one person");
    const tagged = authors.authoredPromptText("p", "c", "hello", noam);
    assert.equal(tagged, "[noam@example.test] hello", "a second person is tagged for the agent");
    authors.recordMessageAuthor("p", "c", tagged, noam, "node-a");
    authors.recordMessageAuthor("p", "c", "hello", dana, "node-a");

    const history = authors.attachMessageAuthors("p", "c", [
      { id: "1", role: "user", text: "hello" },
      { id: "2", role: "assistant", text: "hi" },
      { id: "3", role: "user", text: "[noam@example.test] hello" },
      { id: "4", role: "user", text: "hello" },
      { id: "5", role: "user", text: "typed before authors existed" },
    ]);
    assert.deepEqual(history.map((message) => [message.text, message.author?.email ?? null]), [
      ["hello", "dana@example.test"],
      ["hi", null],
      ["hello", "noam@example.test"],
      ["hello", "dana@example.test"],
      ["typed before authors existed", null],
    ]);
    assert.equal(authors.attachMessageAuthors("p", "other", [{ id: "1", role: "user", text: "hello" }])[0].author, undefined, "authors stay in their own conversation");
    assert.equal(authors.decodeAuthor(authors.encodeAuthor(dana))?.email, dana.email);
    assert.equal(authors.decodeAuthor("not-json"), undefined);
    assert.equal(authors.decodeAuthor(Buffer.from(JSON.stringify({ ...dana, accountId: "x" })).toString("base64url")), undefined, "a malformed author is ignored");
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR; else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
