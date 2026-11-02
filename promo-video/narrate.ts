// Narrates the films with the open-source Kokoro voice that Joint Bob installs on request
// (Settings -> Story mode), so no paid voice service is needed.
//
//   node --import tsx promo-video/narrate.ts [--voice af_bella] [--speed 1] [--force] [--only prefix] [--text "line" --out name]
//
// Lines live in narration.json ({ "lid-01": "A long task..." }). A file that exists is kept unless --force.
// Run from the repository root. Music and sound effects are not voices; audio.sh still makes those.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { toMp3 } from "../src/server/story-voice.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const flag = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
// af_bella is one of the two voices Kokoro's authors rate highest; am_liam, used before, sounded flat.
const voice = flag("--voice") ?? "af_bella";
const speed = Number(flag("--speed") ?? 1);
const force = process.argv.includes("--force");
const only = flag("--only");
const dataDirectory = process.env.JOINT_BOB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");

const lines: Record<string, string> = flag("--text")
  ? { [flag("--out") ?? "test"]: flag("--text")! }
  : JSON.parse(await readFile(path.join(here, "narration.json"), "utf8"));
const outDir = path.join(here, "public/audio");
await mkdir(outDir, { recursive: true });

const { KokoroTTS, env, Mp3Encoder } = await import(pathToFileURL(path.join(dataDirectory, "story-voice-runtime/load.mjs")).href);
env.cacheDir = path.join(dataDirectory, "kokoro-models");
const engine = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });

for (const [name, text] of Object.entries(lines)) {
  if (only && !name.startsWith(only)) continue;
  const file = path.join(outDir, `${name}.mp3`);
  if (!force && await stat(file).then((info) => info.size > 0, () => false)) continue;
  const audio = await engine.generate(text, { voice, speed });
  await writeFile(file, toMp3(audio.audio, audio.sampling_rate, Mp3Encoder));
  console.log(`${name}: ${(audio.audio.length / audio.sampling_rate).toFixed(1)}s  ${text}`);
}

// How long each line is, in seconds, so a film can give every line the time it needs.
if (!flag("--text")) {
  const run = promisify(execFile);
  const lengths: Record<string, number> = {};
  for (const name of Object.keys(lines)) {
    const file = path.join(outDir, `${name}.mp3`);
    if (!await stat(file).then(() => true, () => false)) continue;
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    lengths[name] = Number(Number(stdout.trim()).toFixed(2));
  }
  await writeFile(path.join(here, "film/voice-lengths.js"), `// Written by narrate.ts: how long each narration line in public/audio is, in seconds.\nexport default ${JSON.stringify(lengths, null, 1)};\n`);
}
