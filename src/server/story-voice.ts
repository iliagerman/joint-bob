import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { KokoroTTS } from "kokoro-js";
import { resolveDataDirectory } from "../data-directory.js";
import { GitReviewError } from "../git-review.js";
import { getStorySettings } from "../story-settings.js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const NARRATION_LIMIT = 2_500;

export interface StoryVoiceStatus { available: boolean; reason: string | null }

/** Kokoro is an optional dependency: a node where it did not install can still show stories, just silently. */
export function storyVoiceStatus(): StoryVoiceStatus {
  try {
    import.meta.resolve("kokoro-js");
    return { available: true, reason: null };
  } catch {
    return { available: false, reason: "Kokoro (the kokoro-js package) is not installed on this node, so stories are not narrated here." };
  }
}

let engine: Promise<KokoroTTS> | undefined;

// The first call downloads the model (about 90 MB) into the data directory, where it survives updates.
function loadEngine(): Promise<KokoroTTS> {
  engine ??= Promise.all([import("kokoro-js"), import("@huggingface/transformers")]).then(([{ KokoroTTS }, { env }]) => {
    env.cacheDir = path.join(resolveDataDirectory(), "kokoro-models");
    return KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "cpu" });
  }).catch((error) => {
    engine = undefined;
    throw new GitReviewError(502, `Kokoro could not start: ${error instanceof Error ? error.message : String(error)}`);
  });
  return engine;
}

// One line is spoken at a time; the model is CPU-bound and several at once would only slow each other down.
let queue: Promise<unknown> = Promise.resolve();

/** Where a spoken line is kept: the same words in the same voice and speed are made once. */
export function voiceCacheFile(voice: string, speed: number, text: string): string {
  return path.join(resolveDataDirectory(), "story-voice", `${createHash("sha256").update(`${MODEL}\n${voice}\n${speed}\n${text}`).digest("hex")}.wav`);
}

/** WAV narration of one line for Maya (`host`) or Jonah (`cohost`), in the voices chosen in Settings → Story mode. */
export async function narrateStoryText(text: string, who: "host" | "cohost"): Promise<Buffer> {
  const status = storyVoiceStatus();
  if (!status.available) throw new GitReviewError(409, status.reason!);
  const settings = getStorySettings();
  const voice = who === "host" ? settings.hostVoice : settings.cohostVoice;
  const file = voiceCacheFile(voice, settings.speed, text);
  try { return await readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const spoken = queue.then(async () => {
    const audio = await (await loadEngine()).generate(text, { voice, speed: settings.speed });
    await mkdir(path.dirname(file), { recursive: true });
    await audio.save(file);
  });
  queue = spoken.catch(() => undefined);
  await spoken;
  return readFile(file);
}
