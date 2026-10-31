import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDataDirectory } from "../data-directory.js";
import { GitReviewError } from "../git-review.js";
import { genericSecretEnvironment } from "../secrets.js";
import { getStorySettings, type StorySettings } from "../story-settings.js";

// Local voice is Kokoro-82M on this node's CPU. It is installed only on request and only on nodes with enough
// memory and cores, so a small machine never downloads it. Without it a project can narrate with its own ElevenLabs key.
export const KOKORO_MIN_MEMORY_BYTES = 8 * 2 ** 30;
export const KOKORO_MIN_CORES = 4;
const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const KOKORO_PACKAGES = ["kokoro-js@1.2.1", "@huggingface/transformers@3.8.1"];
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";
const ELEVEN_MODEL = "eleven_flash_v2_5";
const ELEVEN_KEY = "ELEVENLABS_API_KEY";
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
const loaderFile = () => path.join(runtimeDirectory(), "load.mjs");

export function localVoiceInstalled(): boolean {
  return existsSync(loaderFile());
}

let installing: Promise<void> | undefined;
let installError: string | null = null;

export interface LocalVoiceStatus { allowed: boolean; installed: boolean; installing: boolean; installError: string | null; reason: string | null }

export function localVoiceStatus(): LocalVoiceStatus {
  const { allowed, reason } = localVoiceAllowed(os.totalmem(), os.cpus().length);
  return { allowed, installed: localVoiceInstalled(), installing: installing !== undefined, installError: installError, reason };
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
    .then(() => writeFile(loaderFile(), 'export { KokoroTTS } from "kokoro-js";\nexport { env } from "@huggingface/transformers";\n'))
    .catch((error: Error) => { installError = error.message; })
    .finally(() => { installing = undefined; });
}

// The loader is a file inside the runtime, so kokoro-js and the cache settings share one copy of transformers.
let engine: Promise<{ KokoroTTS: { from_pretrained(id: string, options: object): Promise<KokoroEngine> }; env: { cacheDir: string } }> | undefined;

interface KokoroEngine {
  generate(text: string, options: { voice: string; speed: number }): Promise<{ save(file: string): Promise<void> }>;
}

function loadKokoro(): Promise<KokoroEngine> {
  engine ??= import(pathToFileURL(loaderFile()).href);
  return engine.then(({ KokoroTTS, env }) => {
    env.cacheDir = path.join(resolveDataDirectory(), "kokoro-models");
    return KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: "q8", device: "cpu" });
  }).catch((error: Error) => {
    engine = undefined;
    throw new GitReviewError(502, `Kokoro could not start: ${error.message}`);
  });
}

// One line is spoken at a time: the model is CPU-bound and parallel lines would only slow each other down.
let queue: Promise<unknown> = Promise.resolve();

export function storyVoiceKey(projectId: string): string | undefined {
  return genericSecretEnvironment(projectId)[ELEVEN_KEY];
}

/** Which engine narrates for this project right now, or why none can. */
export function narrationProvider(projectId: string, settings: StorySettings = getStorySettings()): { provider: VoiceProvider | null; reason: string | null } {
  const kokoro = localVoiceStatus();
  const kokoroReady = kokoro.allowed && kokoro.installed;
  const elevenKey = () => Boolean(storyVoiceKey(projectId));
  if (settings.voiceProvider === "kokoro") return kokoroReady ? { provider: "kokoro", reason: null } : { provider: null, reason: kokoro.reason ?? "Local voice is not installed on this node. Install it in Settings → Story mode." };
  if (settings.voiceProvider === "elevenlabs") return elevenKey() ? { provider: "elevenlabs", reason: null } : { provider: null, reason: noKeyReason() };
  if (kokoroReady) return { provider: "kokoro", reason: null };
  if (elevenKey()) return { provider: "elevenlabs", reason: null };
  return { provider: null, reason: kokoro.allowed ? "Local voice is not installed, and this project has no ElevenLabs key. Install local voice in Settings → Story mode, or add an ELEVENLABS_API_KEY secret to the project." : noKeyReason() };
}

function noKeyReason(): string {
  return "This project has no ElevenLabs key. Add an ELEVENLABS_API_KEY secret to the project to narrate stories.";
}

function voiceFile(provider: VoiceProvider, voice: string, speed: number, text: string): string {
  const key = createHash("sha256").update(`${provider}\n${voice}\n${speed}\n${text}`).digest("hex");
  return path.join(resolveDataDirectory(), "story-voice", `${key}.${provider === "kokoro" ? "wav" : "mp3"}`);
}

export interface NarrationAudio { bytes: Buffer; mime: "audio/wav" | "audio/mpeg" }

/** The Settings tab's "Test voices": one sentence in Kokoro, which needs no project. */
export async function testStoryVoice(who: "host" | "cohost"): Promise<NarrationAudio> {
  const status = localVoiceStatus();
  if (!status.allowed || !status.installed) throw new GitReviewError(409, status.reason ?? "Local voice is not installed on this node.");
  const settings = getStorySettings();
  const voice = who === "host" ? settings.hostVoice : settings.cohostVoice;
  const text = who === "host" ? "Hi, I'm Maya. I explain what changed and why." : "And I'm Jonah. I ask what a teammate would ask.";
  const file = voiceFile("kokoro", voice, settings.speed, text);
  try { return { bytes: await readFile(file), mime: "audio/wav" }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { bytes: await speakWithKokoro(voice, settings.speed, text, file), mime: "audio/wav" };
}

/** Audio of one line for Maya (`host`) or Jonah (`cohost`). Each line is made once and replayed from disk. */
export async function narrateStoryText(projectId: string, text: string, who: "host" | "cohost", fetchImpl: typeof fetch = fetch): Promise<NarrationAudio> {
  const settings = getStorySettings();
  const { provider, reason } = narrationProvider(projectId, settings);
  if (!provider) throw new GitReviewError(409, reason!);
  const voice = provider === "kokoro"
    ? (who === "host" ? settings.hostVoice : settings.cohostVoice)
    : (who === "host" ? settings.elevenHostVoice : settings.elevenCohostVoice);
  const file = voiceFile(provider, voice, settings.speed, text);
  const mime = provider === "kokoro" ? "audio/wav" : "audio/mpeg";
  try { return { bytes: await readFile(file), mime }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const bytes = provider === "kokoro"
    ? await speakWithKokoro(voice, settings.speed, text, file)
    : await speakWithElevenLabs(storyVoiceKey(projectId)!, voice, text, file, fetchImpl);
  return { bytes, mime };
}

async function speakWithKokoro(voice: string, speed: number, text: string, file: string): Promise<Buffer> {
  const spoken = queue.then(async () => {
    const audio = await (await loadKokoro()).generate(text, { voice, speed });
    await mkdir(path.dirname(file), { recursive: true });
    await audio.save(file);
  });
  queue = spoken.catch(() => undefined);
  await spoken;
  return readFile(file);
}

export async function speakWithElevenLabs(apiKey: string, voice: string, text: string, file: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: ELEVEN_MODEL }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: { message?: string } | string } | null;
    const detail = typeof body?.detail === "string" ? body.detail : body?.detail?.message ?? response.statusText;
    throw new GitReviewError(502, `ElevenLabs refused the narration (${response.status}): ${detail}`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, audio);
  return audio;
}
