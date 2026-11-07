import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GitReviewError } from "../src/git-review.js";
import { resolveDataDirectory } from "../src/data-directory.js";
import { KOKORO_MIN_CORES, KOKORO_MIN_MEMORY_BYTES, kokoroCanSay, localVoiceAllowed, localVoiceStatus, speakWithElevenLabs, speechParts, testStoryVoice, toMp3 } from "../src/server/story-voice.js";

const GB = 2 ** 30;

test("local voice is offered only to a computer with enough memory and cores", () => {
  assert.deepEqual(localVoiceAllowed(16 * GB, 4), { allowed: true, reason: null });
  assert.deepEqual(localVoiceAllowed(KOKORO_MIN_MEMORY_BYTES, KOKORO_MIN_CORES), { allowed: true, reason: null });
  const small = localVoiceAllowed(4 * GB, 8);
  assert.equal(small.allowed, false);
  assert.match(small.reason!, /4 GB of memory and 8 cores.*ElevenLabs/);
  assert.equal(localVoiceAllowed(32 * GB, KOKORO_MIN_CORES - 2).allowed, false);
});

test("the Settings voice test refuses until local voice is installed", async () => {
  await assert.rejects(testStoryVoice("host"), (error: GitReviewError) => error.status === 409);
});

test("ElevenLabs narration sends the key and the voice, and says why when it refuses", async () => {
  const calls: Array<{ url: string; key: string; body: { text: string; model_id: string } }> = [];
  const accept = (async (url: string, init: RequestInit) => {
    calls.push({ url, key: (init.headers as Record<string, string>)["xi-api-key"], body: JSON.parse(init.body as string) });
    return new Response(Buffer.from("mp3-bytes"), { status: 200 });
  }) as unknown as typeof fetch;
  const file = path.join(resolveDataDirectory(), `eleven-${Math.random()}.mp3`);
  assert.equal((await speakWithElevenLabs("key-1", "EXAVITQu4vr4xnSDxMaL", "Hello there", file, accept)).toString(), "mp3-bytes");
  assert.equal((await readFile(file)).toString(), "mp3-bytes");
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL?output_format=mp3_44100_64");
  assert.equal(calls[0].key, "key-1");
  assert.equal(calls[0].body.text, "Hello there");
  const refuse = (async () => new Response(JSON.stringify({ detail: { message: "Invalid API key" } }), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(speakWithElevenLabs("bad", "EXAVITQu4vr4xnSDxMaL", "Refused", file, refuse), (error: GitReviewError) => error.status === 502 && /401.*Invalid API key/.test(error.message));
});

test("local voice lines are encoded as mono MP3 at 48 kbps, from 16-bit samples clamped to range, in MP3-sized frames", () => {
  const calls: Array<{ channels?: number; rate?: number; kbps?: number; samples?: number[] }> = [];
  class FakeEncoder {
    constructor(channels: number, rate: number, kbps: number) { calls.push({ channels, rate, kbps }); }
    encodeBuffer(samples: Int16Array) { calls.push({ samples: [...samples.slice(0, 4)] }); return Int8Array.of(samples.length % 128); }
    flush() { return Int8Array.of(9); }
  }
  const samples = new Float32Array(1152 + 10);
  samples.set([0, 0.5, -1, 2]);
  const mp3 = toMp3(samples, 24_000, FakeEncoder);
  assert.deepEqual(calls[0], { channels: 1, rate: 24_000, kbps: 48 });
  assert.deepEqual(calls[1].samples, [0, 16384, -32767, 32767]);
  assert.equal(calls.length, 3, "one call per 1152-sample frame");
  assert.deepEqual([...mp3], [1152 % 128, 10, 9]);
});

test("a local voice installed before MP3 encoding reads as outdated, not installed", async () => {
  const loader = path.join(resolveDataDirectory(), "story-voice-runtime", "load.mjs");
  await mkdir(path.dirname(loader), { recursive: true });
  await writeFile(loader, 'export { KokoroTTS } from "kokoro-js";\nexport { env } from "@huggingface/transformers";\n');
  try {
    const status = localVoiceStatus();
    assert.equal(status.installed, false);
    assert.equal(status.outdated, true);
  } finally {
    await rm(path.dirname(loader), { recursive: true, force: true });
  }
  assert.equal(localVoiceStatus().outdated, false);
});

test("long text is spoken in parts Kokoro won't cut off, ending on a sentence where it can", () => {
  assert.deepEqual(speechParts("  One short line.  "), ["One short line."]);
  assert.deepEqual(speechParts("First sentence here. Second one here. Third.", 30), ["First sentence here.", "Second one here.", "Third."]);
  assert.deepEqual(speechParts("One. Two. Three.", 30), ["One. Two. Three."], "short sentences stay together, so the voice doesn't pause between them");
  const words = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");
  const parts = speechParts(words);
  assert.ok(parts.length > 1 && parts.every(part => part.length <= 300), "text with no sentence ends is still cut");
  assert.equal(parts.join(" "), words, "and nothing is lost");
});

test("Kokoro is only given text its English voices can say", () => {
  assert.equal(kokoroCanSay("Hotel in Rome, 14 Dec. It's €90!"), true);
  assert.equal(kokoroCanSay("Café in São Paulo"), true);
  assert.equal(kokoroCanSay("מה עם המלון?"), false);
  assert.equal(kokoroCanSay("The hotel is called המלון."), false);
  assert.equal(kokoroCanSay("Привет"), false);
});

test("Whisper reads the language first, transcribes in it, and reads at most 10 minutes", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "whisper-worker-"));
  try {
    const worker = fileURLToPath(new URL("../bin/joint-bob-transcribe.mjs", import.meta.url));
    const ffmpeg = path.join(folder, "ffmpeg");
    const loader = path.join(folder, "load.mjs");
    await writeFile(loader, `export const env = {};
export const ffmpegPath = ${JSON.stringify(ffmpeg)};
export class Tensor {}
export async function pipeline(task, model) {
  const transcriber = async (audio, options) => ({ text: JSON.stringify({ task, model, samples: audio.length, language: options.language, cache: env.cacheDir }) });
  transcriber.processor = async audio => { if (audio.length > 480000) throw new Error("the language is judged on 30 seconds"); return { input_features: {} }; };
  transcriber.model = Object.assign(async () => ({ logits: { data: [1, 9, 3] } }), { generation_config: { decoder_start_token_id: 7, lang_to_id: { "<|en|>": 0, "<|he|>": 1, "<|fr|>": 2 } } });
  return transcriber;
}`);
    const run = async (bytes: number) => {
      await writeFile(ffmpeg, `#!/bin/sh\nhead -c ${bytes} /dev/zero\n`);
      await chmod(ffmpeg, 0o700);
      const { stdout } = await promisify(execFile)(process.execPath, [worker, loader, "/models", "/audio"], { maxBuffer: 1024 * 1024 });
      const { text, cut } = JSON.parse(stdout) as { text: string; cut: boolean };
      return { ...JSON.parse(text) as Record<string, unknown>, cut };
    };
    const short = await run(16_000 * 4);
    assert.deepEqual(short, { task: "automatic-speech-recognition", model: "onnx-community/whisper-small", samples: 16_000, language: "he", cache: "/models", cut: false });
    const long = await run((10 * 60 + 1) * 16_000 * 4);
    assert.deepEqual([long.samples, long.cut], [10 * 60 * 16_000, true]);
    await writeFile(ffmpeg, "#!/bin/sh\necho 'no audio in this file' >&2\nexit 1\n");
    await assert.rejects(promisify(execFile)(process.execPath, [worker, loader, "/models", "/audio"]), /no audio in this file/, "an unreadable file fails and says why");
  } finally { await rm(folder, { recursive: true, force: true }); }
});
