import assert from "node:assert/strict";
import test from "node:test";
import { GitReviewError } from "../src/git-review.js";
import { narrateStoryText } from "../src/server/story-voice.js";

test("narration is requested once, then replayed from disk", async () => {
  const text = `Narration ${Math.random()}`;
  const calls: Array<{ url: string; key: string; body: { text: string } }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, key: (init.headers as Record<string, string>)["xi-api-key"], body: JSON.parse(init.body as string) });
    return new Response(Buffer.from("mp3-bytes"), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal((await narrateStoryText("key-1", text, fetchImpl)).toString(), "mp3-bytes");
  assert.equal((await narrateStoryText("key-1", text, fetchImpl)).toString(), "mp3-bytes");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\//);
  assert.equal(calls[0].key, "key-1");
  assert.equal(calls[0].body.text, text);
});

test("a missing key and an ElevenLabs refusal both say why", async () => {
  await assert.rejects(narrateStoryText(undefined, "Hello"), (error: GitReviewError) => error.status === 409 && /ELEVENLABS_API_KEY/.test(error.message));
  const refuse = (async () => new Response(JSON.stringify({ detail: { message: "Invalid API key" } }), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(narrateStoryText("bad", `Refused ${Math.random()}`, refuse), (error: GitReviewError) => error.status === 502 && /401.*Invalid API key/.test(error.message));
});
