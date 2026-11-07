#!/usr/bin/env node
// One audio file to text with Whisper, in its own process: the model takes over a gigabyte and
// every core while it runs, and all of that is given back when this exits.
import { execFile } from "node:child_process";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const MODEL = "onnx-community/whisper-small";
const RATE = 16_000;
const MAX_SECONDS = 10 * 60;
const CHUNK_SECONDS = 30;

const [loader, cacheDir, audioFile] = process.argv.slice(2);
os.setPriority(10); // The server stays responsive while this uses every core.
const { env, ffmpegPath, pipeline, Tensor } = await import(pathToFileURL(loader).href);
env.cacheDir = cacheDir;

const decoded = await promisify(execFile)(ffmpegPath, ["-loglevel", "error", "-i", audioFile, "-t", String(MAX_SECONDS + 1), "-vn", "-f", "f32le", "-ac", "1", "-ar", String(RATE), "pipe:1"], { encoding: "buffer", maxBuffer: (MAX_SECONDS + 2) * RATE * 4 });
const samples = new Float32Array(Math.floor(decoded.stdout.byteLength / 4));
Buffer.from(samples.buffer).set(decoded.stdout.subarray(0, samples.byteLength));
const cut = samples.length > MAX_SECONDS * RATE;
const audio = cut ? samples.subarray(0, MAX_SECONDS * RATE) : samples;

const transcriber = await pipeline("automatic-speech-recognition", MODEL, { dtype: { encoder_model: "q8", decoder_model_merged: "q8" }, device: "cpu" });

/** Transformers.js assumes English unless told otherwise, so the model's first word, which is a language, is read here. */
async function detectLanguage() {
  const config = transcriber.model.generation_config;
  const { input_features } = await transcriber.processor(audio.slice(0, CHUNK_SECONDS * RATE));
  const decoder_input_ids = new Tensor("int64", BigInt64Array.from([BigInt(config.decoder_start_token_id)]), [1, 1]);
  const { logits } = await transcriber.model({ input_features, decoder_input_ids });
  const [best] = Object.entries(config.lang_to_id).sort(([, left], [, right]) => logits.data[right] - logits.data[left]);
  return best[0].slice(2, -2);
}

const { text } = await transcriber(audio, { language: await detectLanguage(), task: "transcribe", chunk_length_s: CHUNK_SECONDS, stride_length_s: 5 });
process.stdout.write(JSON.stringify({ text, cut }), () => process.exit(0));
