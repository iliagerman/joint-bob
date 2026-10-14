// Renders a film without a video framework: the film is a plain page (film/), this script
// asks it for one frame at a time, photographs each in headless Chrome, and hands the frames
// and the sound to ffmpeg. The films are listed in film/films.js.
//
//   node --import tsx promo-video/render.ts [--film NAME] [--out FILE] [--still FRAME] [--stills A,B,C --out DIR] [--workers N]   (from the repository root)
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome } from "../test/ui/launch-chrome.js";
// The films are plain JavaScript, shared with the page.
import { FPS, HEIGHT, WIDTH } from "./film/timeline.js";
import { films } from "./film/films.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const flag = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; };
const still = flag("--still") === undefined ? undefined : Number(flag("--still"));
// Several frames at once, for looking over a film without rendering all of it.
const stills = flag("--stills")?.split(",").map(Number);
const name = flag("--film") ?? "teaser";
interface Source { screen: string; clip: string | null; index: number | null }
interface Cue { audio: string; at: number; volume: number; offset?: number; length?: number; fadeIn?: number; fadeOut?: number; tempo?: number }
const film = (films as Record<string, { duration: number; frameAt(frame: number): number; sounds: Cue[]; sources(frame: number, meta: unknown, counts: Record<string, number>): Source[] }>)[name];
if (!film) throw new Error(`No film called ${name}. There are: ${Object.keys(films).join(", ")}`);
const output = path.resolve(flag("--out") ?? path.join(here, "out", stills ? "stills" : still === undefined ? `${name}.mp4` : `${name}-${String(still).padStart(4, "0")}.jpg`));
const workers = Number(flag("--workers") ?? 4);

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on("close", (status) => status === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${status}: ${stderr}`)));
  });
}

const meta = JSON.parse(await readFile(path.join(here, "public/captures/meta.json"), "utf8")) as Record<string, { file: string }>;
const wanted = stills ?? (still === undefined ? Array.from({ length: film.duration }, (_, frame) => frame) : [still]);

// Scratch space outside the project, so half a gigabyte of frames is never synchronized.
const work = await mkdtemp(path.join(os.tmpdir(), "jb-promo-render-"));
let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
const server = createServer();
try {
  // 1. Pull out of each recording exactly the frames the film shows.
  const manifest: { frames: Record<string, number> } = { frames: {} };
  await Promise.all(Object.keys(meta).map(async (clip) => {
    manifest.frames[clip] = Number((await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path.join(here, "public/captures", meta[clip].file)])).trim());
  }));
  const shown = new Map<string, Set<number>>();
  for (const frame of wanted) {
    for (const source of film.sources(film.frameAt(frame), meta, manifest.frames)) {
      if (source.clip === null || source.index === null) continue;
      if (!shown.has(source.clip)) shown.set(source.clip, new Set());
      shown.get(source.clip)!.add(source.index);
    }
  }
  const extractions: Array<() => Promise<string>> = [];
  for (const [clip, indexes] of shown) {
    const source = path.join(here, "public/captures", meta[clip].file);
    const needed = [...indexes].sort((a, b) => a - b);
    const ranges: Array<[number, number]> = [];
    for (const index of needed) {
      const last = ranges.at(-1);
      // Frames a few apart come out in one pass, with the ones between them: a stretch played
      // faster than it was recorded would otherwise need a pass of its own for every frame.
      if (last && index <= last[1] + 20) last[1] = index;
      else ranges.push([index, index]);
    }
    await mkdir(path.join(work, "frames", clip), { recursive: true });
    // A run of consecutive frames comes out numbered from its first frame, so file names are recording frame numbers.
    for (const [first, last] of ranges) extractions.push(() => run("ffmpeg", ["-v", "error", "-i", source, "-vf", `select=between(n\\,${first}\\,${last})`, "-fps_mode", "passthrough", "-q:v", "2", "-start_number", String(first), path.join(work, "frames", clip, "%d.jpg")]));
  }
  // A few at a time: each pass decodes its clip from the start.
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (next < extractions.length) await extractions[next++](); }));
  await writeFile(path.join(work, "manifest.json"), JSON.stringify(manifest));

  // 2. Serve the page, its modules and the extracted frames on a loopback port.
  const roots: Array<[string, string]> = [["/film/", path.join(here, "film")], ["/public/", path.join(here, "public")], ["/three/", path.join(here, "node_modules/three/build")], ["/work/", work]];
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
  server.on("request", async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost").pathname;
    const root = roots.find(([prefix]) => url.startsWith(prefix));
    const file = url === "/" ? path.join(here, "film/index.html") : root ? path.join(root[1], url.slice(root[0].length)) : undefined;
    if (!file || (root && !file.startsWith(root[1])) || !(await stat(file).then((info) => info.isFile(), () => false))) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // 3. Photograph every frame. HOME points at the scratch folder, so Chrome touches no real profile.
  browser = await launchChrome({ headless: true, env: { ...process.env, HOME: work }, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
  await mkdir(path.join(work, "out"), { recursive: true });
  let done = 0;
  // Every page is loaded before any frame is drawn: a page still loading while the others
  // render waits behind them, and can wait past its timeout.
  const pages = [];
  for (let worker = 0; worker < Math.min(workers, wanted.length); worker++) {
    // A window of its own for each page, so none of them is a background tab with its drawing slowed down.
    const page = await (await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })).newPage();
    const state: { failure?: Error } = {};
    page.on("pageerror", (error) => { state.failure = error; });
    await page.goto(`${origin}/?film=${name}`, { timeout: 60_000 });
    await page.waitForFunction("window.film", undefined, { timeout: 60_000 }).catch((error) => { throw state.failure ?? error; });
    pages.push({ page, state });
  }
  console.log(`drawing with ${await pages[0].page.evaluate("window.film.renderer()")}`);
  await Promise.all(pages.map(async ({ page, state }, worker) => {
    for (let position = worker; position < wanted.length; position += pages.length) {
      if (state.failure) throw state.failure;
      const frame = wanted[position];
      await page.evaluate((value) => (window as unknown as { film: { render(frame: number): Promise<void> } }).film.render(value), frame);
      // The film fills the window exactly, so the window is photographed, with no wait for an element to settle.
      await page.screenshot({ path: path.join(work, "out", `${String(position).padStart(5, "0")}.jpg`), type: "jpeg", quality: 96, timeout: 120_000 });
      if (++done % 100 === 0) console.log(`${done}/${wanted.length} frames`);
    }
  }));
  await browser.close();
  browser = undefined;

  await mkdir(stills ? output : path.dirname(output), { recursive: true });
  if (stills) {
    for (const [position, frame] of stills.entries()) await writeFile(path.join(output, `${name}-${String(frame).padStart(4, "0")}.jpg`), await readFile(path.join(work, "out", `${String(position).padStart(5, "0")}.jpg`)));
  } else if (still !== undefined) {
    await writeFile(output, await readFile(path.join(work, "out", "00000.jpg")));
  } else {
    // 4. Encode the frames and mix the sound. Each cue is cut to its stretch of the file, slowed to the film's pace
    //    with its pitch kept, faded, and placed at its frame. `length` counts seconds of the file, before slowing.
    const seconds = film.duration / FPS;
    const cues = film.sounds;
    const inputs = ["-framerate", String(FPS), "-i", path.join(work, "out", "%05d.jpg"), ...cues.flatMap((cue) => ["-i", path.join(here, "public", cue.audio)])];
    const graph = [
      ...cues.map((cue, index) => [
        `[${index + 1}:a]atrim=start=${cue.offset ?? 0}${cue.length === undefined ? "" : `:duration=${cue.length}`}`,
        "asetpts=PTS-STARTPTS",
        ...(cue.tempo && cue.tempo !== 1 ? [`atempo=${cue.tempo}`] : []),
        `volume=${cue.volume}`,
        ...(cue.fadeIn ? [`afade=t=in:d=${cue.fadeIn}`] : []),
        ...(cue.fadeOut && cue.length !== undefined ? [`afade=t=out:st=${Math.max(0, cue.length / (cue.tempo ?? 1) - cue.fadeOut)}:d=${cue.fadeOut}`] : []),
        `adelay=${Math.round((cue.at / FPS) * 1000)}:all=1[s${index}]`,
      ].join(",")),
      `${cues.map((_, index) => `[s${index}]`).join("")}amix=inputs=${cues.length}:normalize=0:duration=longest,alimiter=limit=0.9,atrim=0:${seconds}[a]`,
    ].join(";");
    await run("ffmpeg", ["-y", "-v", "error", ...inputs, "-filter_complex", graph, "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-t", String(seconds), "-movflags", "+faststart", output]);
  }
  console.log(output);
} finally {
  await browser?.close();
  server.close();
  await rm(work, { recursive: true, force: true });
}
