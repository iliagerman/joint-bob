import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDataDirectory } from "../data-directory.js";
import { GitReviewError } from "../git-review.js";
import { elevenLabsKey } from "../secrets.js";
import { getStorySettings, type StorySettings } from "../story-settings.js";
import { storyVoiceDirectory } from "../story-scripts.js";

// Local voice is Kokoro-82M, and Whisper for listening (speech-to-text.ts), on this node's CPU. It is installed only on
// request and only on nodes with enough memory and cores, so a small machine never downloads it. Without it a project can
// use its own ElevenLabs key.
export const KOKORO_MIN_MEMORY_BYTES = 8 * 2 ** 30;
export const KOKORO_MIN_CORES = 4;
const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
// lamejs (LGPL) encodes lines as MP3 and ffmpeg (GPL) decodes any audio for Whisper. Like Kokoro they live only in this
// on-request runtime, never in Joint Bob's own packages.
const KOKORO_PACKAGES = ["kokoro-js@1.2.1", "@huggingface/transformers@3.8.1", "@breezystack/lamejs@1.2.7", "ffmpeg-static@5.3.0"];
// Changes whenever the runtime gains a package; an older install updates itself the next time a story checks its voice.
const RUNTIME_VERSION = "3";
export const LOCAL_VOICE_LOADER = `// Joint Bob local voice runtime ${RUNTIME_VERSION}\nexport { KokoroTTS } from "kokoro-js";\nexport { env, pipeline, Tensor } from "@huggingface/transformers";\nexport { Mp3Encoder } from "@breezystack/lamejs";\nexport { default as ffmpegPath } from "ffmpeg-static";\n`;
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";
const ELEVEN_MODEL = "eleven_flash_v2_5";
/** Speaks the most languages, Hebrew included, which a person's answer may be in. */
const ELEVEN_REPLY_MODEL = "eleven_v3";
export const elevenLabsApi = (): string => process.env.JOINT_BOB_ELEVENLABS_API || "https://api.elevenlabs.io";
export const NARRATION_LIMIT = 2_500;

export type VoiceProvider = "kokoro" | "elevenlabs";

const gigabytes = (bytes: number) => Math.round(bytes / 2 ** 30 * 10) / 10;

/** Whether this machine is big enough to run Kokoro, and why not when it is not. */
export function localVoiceAllowed(memoryBytes: number, cores: number): { allowed: boolean; reason: string | null } {
  if (memoryBytes >= KOKORO_MIN_MEMORY_BYTES && cores >= KOKORO_MIN_CORES) return { allowed: true, reason: null };
  return {
    allowed: false,
    reason: `This node has ${gigabytes(memoryBytes)} GB of memory and ${cores} cores. Local voice needs ${KOKORO_MIN_MEMORY_BYTES / 2 ** 30} GB and ${KOKORO_MIN_CORES} cores, so it is not offered here. Add an ElevenLabs key to narrate stories instead.`,
  };
}

const runtimeDirectory = () => path.join(resolveDataDirectory(), "story-voice-runtime");
export const localVoiceLoaderFile = () => path.join(runtimeDirectory(), "load.mjs");

function loaderState(): "missing" | "outdated" | "current" {
  try {
    return readFileSync(localVoiceLoaderFile(), "utf8") === LOCAL_VOICE_LOADER ? "current" : "outdated";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export function localVoiceInstalled(): boolean {
  return loaderState() === "current";
}

let installing: Promise<void> | undefined;
let installError: string | null = null;

export interface LocalVoiceStatus { allowed: boolean; installed: boolean; outdated: boolean; installing: boolean; installError: string | null; reason: string | null }

export function localVoiceStatus(): LocalVoiceStatus {
  const { allowed, reason } = localVoiceAllowed(os.totalmem(), os.cpus().length);
  const state = loaderState();
  return { allowed, installed: state === "current", outdated: state === "outdated", installing: installing !== undefined, installError: installError, reason };
}

// npm runs in the background; the Settings tab polls the status. CUDA is skipped: onnxruntime-node would otherwise
// download GPU libraries on Linux, which this package never needs for CPU narration.
function runNpmInstall(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["install", "--prefix", runtimeDirectory(), "--no-save", "--package-lock=false", "--omit=dev", `--registry=${PUBLIC_NPM_REGISTRY}`, ...KOKORO_PACKAGES], {
      env: { ...process.env, ONNXRUNTIME_NODE_INSTALL_CUDA: "skip" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install stopped with code ${code}. ${stderr.trim().split("\n").at(-1) ?? ""}`));
    });
  });
}

/** Installs Kokoro into the data directory. Refused on machines too small to run it. */
export async function startLocalVoiceInstall(): Promise<void> {
  const { allowed, reason } = localVoiceAllowed(os.totalmem(), os.cpus().length);
  if (!allowed) throw new GitReviewError(409, reason!);
  if (installing) return;
  installError = null;
  await mkdir(runtimeDirectory(), { recursive: true });
  installing = runNpmInstall()
    .then(() => writeFile(localVoiceLoaderFile(), LOCAL_VOICE_LOADER))
    .then(() => { runtime = undefined; })
    .catch((error: Error) => { installError = error.message; })
    .finally(() => { installing = undefined; });
}

// The loader is a file inside the runtime, so kokoro-js and the cache settings share one copy of transformers.
/** Brings an older install up to date. Only a computer that already had local voice is updated. */
export function updateLocalVoice(): void {
  const status = localVoiceStatus();
  if (status.allowed && status.outdated && !status.installing) startLocalVoiceInstall().catch((error: Error) => { installError = error.message; });
}

type Mp3Encoder = new (channels: number, rate: number, kbps: number) => { encodeBuffer(samples: Int16Array): Int8Array; flush(): Int8Array };
interface VoiceRuntime { KokoroTTS: { from_pretrained(id: string, options: object): Promise<KokoroEngine> }; env: { cacheDir: string }; Mp3Encoder: Mp3Encoder }
let runtime: Promise<VoiceRuntime> | undefined;

interface KokoroEngine {
  generate(text: string, options: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

/** MP3 at 48 kbps: about an eighth of the size of a WAV, and every browser plays it, Safari included. */
export function toMp3(samples: Float32Array, rate: number, Encoder: Mp3Encoder): Buffer {
  const pcm = Int16Array.from(samples, (sample) => Math.round(Math.max(-1, Math.min(1, sample)) * 32767));
  const encoder = new Encoder(1, rate, 48);
  const parts: Int8Array[] = [];
  for (let start = 0; start < pcm.length; start += 1152) parts.push(encoder.encodeBuffer(pcm.subarray(start, start + 1152)));
  parts.push(encoder.flush());
  return Buffer.concat(parts.map((part) => Buffer.from(part.buffer, part.byteOffset, part.length)));
}

// The version in the URL makes a running server load the updated runtime instead of the copy it imported before.
function loadRuntime(): Promise<VoiceRuntime> {
  runtime ??= import(`${pathToFileURL(localVoiceLoaderFile()).href}?v=${RUNTIME_VERSION}`);
  return runtime;
}

function loadKokoro(): Promise<KokoroEngine> {
  return loadRuntime().then(({ KokoroTTS, env }) => {
    env.cacheDir = path.join(resolveDataDirectory(), "kokoro-models");
    return KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: "q8", device: "cpu" });
  }).catch((error: Error) => {
    runtime = undefined;
    throw new GitReviewError(502, `Kokoro could not start: ${error.message}`);
  });
}

// One line is spoken at a time: the model is CPU-bound and parallel lines would only slow each other down.
let queue: Promise<unknown> = Promise.resolve();


/** Which engine narrates for this project right now, or why none can. */
export function narrationProvider(projectId: string, settings: StorySettings = getStorySettings()): { provider: VoiceProvider | null; reason: string | null } {
  const kokoro = localVoiceStatus();
  const kokoroReady = kokoro.allowed && kokoro.installed;
  const eleven = elevenLabsKey(projectId);
  const elevenReady = eleven !== undefined && "key" in eleven;
  const elevenReason = eleven && "conflict" in eleven
    ? `This project has ${eleven.conflict} ElevenLabs secret accounts at the same level. Keep one so the narrator is clear.`
    : "This project has no ElevenLabs secret. Add a secret account of type ElevenLabs (Settings → Secrets) and attach it to the project.";
  const localReason = kokoro.reason ?? (kokoro.installError
    ? `Installing local voice on ${os.hostname()} failed: ${kokoro.installError} Try again in Settings → Activity overview.`
    : null) ?? (kokoro.outdated
    ? `Local voice on ${os.hostname()} is being updated. It speaks again in a minute or two.`
    : null) ?? `Local voice is not installed on ${os.hostname()}, the computer that narrates this project. Install it there in Settings → Activity overview.`;
  if (settings.voiceProvider === "kokoro") return kokoroReady ? { provider: "kokoro", reason: null } : { provider: null, reason: localReason };
  if (settings.voiceProvider === "elevenlabs") return elevenReady ? { provider: "elevenlabs", reason: null } : { provider: null, reason: elevenReason };
  if (kokoroReady) return { provider: "kokoro", reason: null };
  if (elevenReady) return { provider: "elevenlabs", reason: null };
  return { provider: null, reason: kokoro.allowed && !eleven ? `${localReason} Or attach a secret account of type ElevenLabs to the project.` : elevenReason };
}

function voiceFile(provider: VoiceProvider, voice: string, speed: number, text: string): string {
  // "mp3" keeps local voice lines saved as WAV before from being served again.
  const key = createHash("sha256").update(`${provider}\n${voice}\n${speed}\n${text}${provider === "kokoro" ? "\nmp3" : ""}`).digest("hex");
  return path.join(storyVoiceDirectory(), `${key}.mp3`);
}

export interface NarrationAudio { bytes: Buffer; mime: "audio/mpeg" }

/** The Settings tab's "Test voices": one sentence in Kokoro, which needs no project. */
export async function testStoryVoice(who: "host" | "cohost"): Promise<NarrationAudio> {
  const status = localVoiceStatus();
  if (!status.allowed || !status.installed) throw new GitReviewError(409, status.reason ?? "Local voice is not installed on this node.");
  const settings = getStorySettings();
  const voice = who === "host" ? settings.hostVoice : settings.cohostVoice;
  const text = who === "host" ? "Hi, I'm Maya. I explain what changed and why." : "And I'm Jonah. I ask what a teammate would ask.";
  const file = voiceFile("kokoro", voice, settings.speed, text);
  try { return { bytes: await readFile(file), mime: "audio/mpeg" }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { bytes: await speakWithKokoro(voice, settings.speed, text, file), mime: "audio/mpeg" };
}

/** Audio of one line for Maya (`host`) or Jonah (`cohost`). Each line is made once and replayed from disk. */
/** `settings` are the viewer's own voice choices; this node's are used when absent. Only the engine itself (Kokoro, a key) is this node's. */
export async function narrateStoryText(projectId: string, text: string, who: "host" | "cohost", settings: StorySettings = getStorySettings(), fetchImpl: typeof fetch = fetch): Promise<NarrationAudio> {
  const { provider, reason } = narrationProvider(projectId, settings);
  if (!provider) throw new GitReviewError(409, reason!);
  const voice = provider === "kokoro"
    ? (who === "host" ? settings.hostVoice : settings.cohostVoice)
    : (who === "host" ? settings.elevenHostVoice : settings.elevenCohostVoice);
  const file = voiceFile(provider, voice, settings.speed, text);
  const mime = "audio/mpeg";
  try { return { bytes: await readFile(file), mime }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const bytes = provider === "kokoro"
    ? await speakWithKokoro(voice, settings.speed, text, file)
    : await speakWithElevenLabs((elevenLabsKey(projectId) as { key: string }).key, voice, text, file, fetchImpl);
  return { bytes, mime };
}

/** Kokoro reads about 500 sounds at a time and silently drops the rest, so longer text is spoken in parts that end on a sentence where they can. */
const KOKORO_PART_CHARS = 300;
export function speechParts(text: string, limit = KOKORO_PART_CHARS): string[] {
  const parts: string[] = [];
  let part = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (part && part.length + word.length + 1 > limit) { parts.push(part); part = ""; }
    part += `${part ? " " : ""}${word}`;
    if (/[.!?]$/.test(word) && part.length >= limit / 2) { parts.push(part); part = ""; }
  }
  if (part) parts.push(part);
  return parts;
}

function kokoroSpeech(voice: string, speed: number, text: string): Promise<Buffer> {
  const spoken = queue.then(async () => {
    const engine = await loadKokoro();
    const parts: Array<{ audio: Float32Array; sampling_rate: number }> = [];
    for (const part of speechParts(text)) parts.push(await engine.generate(part, { voice, speed }));
    const samples = new Float32Array(parts.reduce((total, part) => total + part.audio.length, 0));
    let offset = 0;
    for (const part of parts) { samples.set(part.audio, offset); offset += part.audio.length; }
    return toMp3(samples, parts[0].sampling_rate, (await loadRuntime()).Mp3Encoder);
  });
  queue = spoken.catch(() => undefined);
  return spoken;
}

async function speakWithKokoro(voice: string, speed: number, text: string, file: string): Promise<Buffer> {
  const audio = await kokoroSpeech(voice, speed, text);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, audio);
  return audio;
}

async function elevenLabsSpeech(apiKey: string, voice: string, text: string, model: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(`${elevenLabsApi()}/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: { message?: string } | string } | null;
    const detail = typeof body?.detail === "string" ? body.detail : body?.detail?.message ?? response.statusText;
    throw new GitReviewError(502, `ElevenLabs refused the narration (${response.status}): ${detail}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function speakWithElevenLabs(apiKey: string, voice: string, text: string, file: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const audio = await elevenLabsSpeech(apiKey, voice, text, ELEVEN_MODEL, fetchImpl);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, audio);
  return audio;
}

/** Kokoro's voices are all English, so a letter from another script would come out as noise. */
export const kokoroCanSay = (text: string): boolean => !/[^\p{Script=Latin}\P{L}]/u.test(text);

/** Speech for an answer, or null when nothing here can say it. Uses the engine and host voice chosen in Settings → Activity overview; it isn't kept on disk like a story's lines. */
export async function speakReply(projectId: string, text: string, fetchImpl: typeof fetch = fetch): Promise<Buffer | null> {
  const settings = getStorySettings();
  if (narrationProvider(projectId, settings).provider === "kokoro" && kokoroCanSay(text)) return kokoroSpeech(settings.hostVoice, settings.speed, text);
  const eleven = elevenLabsKey(projectId);
  if (settings.voiceProvider !== "kokoro" && eleven && "key" in eleven) return elevenLabsSpeech(eleven.key, settings.elevenHostVoice, text, ELEVEN_REPLY_MODEL, fetchImpl);
  return null;
}
