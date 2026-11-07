import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDirectory } from "../data-directory.js";
import { elevenLabsKey } from "../secrets.js";
import { elevenLabsApi, localVoiceLoaderFile, localVoiceStatus } from "./story-voice.js";

// Speech to text. Whisper runs on this machine when local voice is installed; otherwise a project's own ElevenLabs key can do it.

const ELEVEN_MODEL = "scribe_v2";
const ELEVEN_TIMEOUT_MS = 180_000;
/** Whisper takes about as long as the audio on four cores, and it reads at most 10 minutes. The first use also downloads the model. */
const LOCAL_TIMEOUT_MS = 20 * 60_000;
const LOCAL_WORKER = fileURLToPath(new URL("../../bin/joint-bob-transcribe.mjs", import.meta.url));

export type TranscriptionEngine = "local" | "elevenlabs";

export function transcriptionEngine(projectId: string): TranscriptionEngine | null {
  const local = localVoiceStatus();
  if (local.allowed && local.installed) return "local";
  const eleven = elevenLabsKey(projectId);
  return eleven && "key" in eleven ? "elevenlabs" : null;
}

export async function transcribeWithElevenLabs(apiKey: string, audio: Buffer, name: string, mimeType: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const form = new FormData();
  form.append("model_id", ELEVEN_MODEL);
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), name);
  const response = await fetchImpl(`${elevenLabsApi()}/v1/speech-to-text`, { method: "POST", headers: { "xi-api-key": apiKey }, body: form, signal: AbortSignal.timeout(ELEVEN_TIMEOUT_MS) });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: { message?: string } | string } | null;
    throw new Error(`ElevenLabs refused the audio (${response.status}): ${typeof body?.detail === "string" ? body.detail : body?.detail?.message ?? response.statusText}`);
  }
  const { text } = await response.json() as { text?: unknown };
  if (typeof text !== "string") throw new Error("ElevenLabs returned no transcript");
  return text.trim();
}

function runLocalWorker(audioFile: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [LOCAL_WORKER, localVoiceLoaderFile(), path.join(resolveDataDirectory(), "whisper-models"), audioFile], { timeout: LOCAL_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`Whisper stopped: ${stderr.trim().split("\n").at(-1) || error.message}`)); return; }
      const { text, cut } = JSON.parse(stdout) as { text: string; cut: boolean };
      resolve(`${text.trim()}${cut ? "\n[Only the first 10 minutes were transcribed.]" : ""}`);
    });
  });
}

// One at a time: each run uses every core, and running them together would only slow them all down.
let queue: Promise<unknown> = Promise.resolve();

async function transcribeLocally(audio: Buffer): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "joint-bob-voice-"));
  try {
    const file = path.join(folder, "audio");
    await writeFile(file, audio, { mode: 0o600 });
    const words = queue.then(() => runLocalWorker(file));
    queue = words.catch(() => undefined);
    return await words;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

/** The words in some audio, or null when nothing here can transcribe it. Empty when it holds no speech. */
export async function transcribeAudio(projectId: string, audio: Buffer, name: string, mimeType: string): Promise<string | null> {
  const engine = transcriptionEngine(projectId);
  if (engine === "local") return transcribeLocally(audio);
  if (engine === "elevenlabs") return transcribeWithElevenLabs((elevenLabsKey(projectId) as { key: string }).key, audio, name, mimeType);
  return null;
}
