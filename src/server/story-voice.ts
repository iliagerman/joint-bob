import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveDataDirectory } from "../data-directory.js";
import { genericSecretEnvironment } from "../secrets.js";
import { GitReviewError } from "../git-review.js";

const VOICE_VARIABLE = "ELEVENLABS_API_KEY";
const VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const VOICE_MODEL = "eleven_flash_v2_5";
export const NARRATION_LIMIT = 2_500;

export function storyVoiceKey(projectId: string): string | undefined {
  return genericSecretEnvironment(projectId)[VOICE_VARIABLE];
}

/** MP3 narration for one story scene. Replays come from disk so a scene is paid for once. */
export async function narrateStoryText(apiKey: string | undefined, text: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  if (!apiKey) throw new GitReviewError(409, `Add an ${VOICE_VARIABLE} secret to this project to hear the story.`);
  const file = path.join(resolveDataDirectory(), "story-voice", `${createHash("sha256").update(`${VOICE_ID}\n${VOICE_MODEL}\n${text}`).digest("hex")}.mp3`);
  try { return await readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const response = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: VOICE_MODEL }),
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
