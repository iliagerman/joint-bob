// Writes a film's music: a warm, quiet score made in code, with no service and no samples. A felt
// piano plays the chords in broken arpeggios over a soft string pad and a bass; a melody comes in,
// everything grows towards `--peak` (the second the day comes good), lands on C there with bells,
// and settles under the end card. Chords run C, Am, F, G, with a turn through Dm and Em.
//
//   node promo-video/score.mjs --length SECONDS --peak SECONDS --out promo-video/public/audio/score-NAME.mp3
//
// The landing falls on a bar line at or before the peak; the film starts the score late by the
// difference (the script prints it), so the landing meets the peak exactly.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const flag = (name) => { const index = process.argv.indexOf(name); if (index === -1) throw new Error(`${name} is required`); return process.argv[index + 1]; };
const length = Number(flag("--length"));
const peak = Number(flag("--peak"));
const output = path.resolve(flag("--out"));

const rate = 44100;
const bpm = 84;
const beat = 60 / bpm;
const bar = beat * 4;
const total = Math.ceil((length + 3) * rate);
const left = new Float32Array(total);
const right = new Float32Array(total);
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/** Adds a sound made sample by sample: `wave(t)` for `seconds`, placed at `at`, panned between -1 and 1. */
function add(at, seconds, pan, wave) {
  const start = Math.round(at * rate);
  const count = Math.min(Math.round(seconds * rate), total - start);
  const l = Math.cos(((pan + 1) * Math.PI) / 4);
  const r = Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < count; i++) {
    const value = wave(i / rate);
    left[start + i] += value * l;
    right[start + i] += value * r;
  }
}

/** A felt piano note: a few harmonics, the higher ones dying first, soft at the start. */
function piano(at, midi, gain, held = 2.6) {
  const f = hz(midi);
  const fade = 1.4 + (midi - 48) * 0.03;
  add(at, held + 0.6, (midi - 60) / 40, (t) => {
    const attack = Math.min(1, t / 0.006);
    const release = t > held ? Math.max(0, 1 - (t - held) / 0.6) : 1;
    let value = 0;
    const partials = [1, 0.42, 0.18, 0.09, 0.04];
    for (let h = 0; h < partials.length; h++) value += partials[h] * Math.sin(2 * Math.PI * f * (h + 1) * (1 + 0.0004 * h * h) * t) * Math.exp(-t * fade * (1 + 0.8 * h));
    return value * gain * attack * release;
  });
}

/** A string pad holding a chord: detuned voices, slow to swell and slow to go. */
function pad(at, notes, seconds, gain) {
  for (const [index, midi] of notes.entries()) {
    const f = hz(midi);
    add(at, seconds + 2.5, index % 2 ? 0.35 : -0.35, (t) => {
      const swell = Math.min(1, t / 1.8);
      const release = t > seconds ? Math.max(0, 1 - (t - seconds) / 2.5) : 1;
      const shimmer = 1 + 0.08 * Math.sin(2 * Math.PI * 0.27 * t + index);
      let value = 0;
      for (const detune of [-0.003, 0, 0.0035]) value += Math.sin(2 * Math.PI * f * (1 + detune) * t) + 0.22 * Math.sin(4 * Math.PI * f * (1 + detune) * t) + 0.08 * Math.sin(6 * Math.PI * f * (1 + detune) * t);
      return (value / 3) * gain * swell * release * shimmer;
    });
  }
}

function bass(at, midi, gain) {
  const f = hz(midi);
  // Faded out at the end, so the note does not stop with a click.
  add(at, 2.4, 0, (t) => Math.min(1, t / 0.01, (2.4 - t) / 0.5) * Math.exp(-t * 1.1) * gain * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)));
}

function bell(at, midi, gain) {
  const f = hz(midi);
  const partials = [[1, 1], [2.76, 0.45], [5.4, 0.22], [8.93, 0.1]];
  add(at, 4, 0.4, (t) => Math.min(1, t / 0.002) * gain * partials.reduce((sum, [ratio, level], i) => sum + level * Math.sin(2 * Math.PI * f * ratio * t) * Math.exp(-t * 1.6 * (1 + i)), 0));
}

// The chords: broken-chord notes for the piano, the pad's voicing and the bass note.
const chords = {
  C: { arp: [48, 55, 64, 67, 71, 67, 64, 55], pad: [60, 64, 67, 71], root: 36 },
  Am: { arp: [45, 52, 60, 64, 67, 64, 60, 52], pad: [57, 60, 64, 67], root: 45 },
  F: { arp: [41, 48, 57, 60, 64, 60, 57, 48], pad: [57, 60, 64, 65], root: 41 },
  G: { arp: [43, 50, 59, 62, 64, 62, 59, 50], pad: [55, 59, 62, 64], root: 43 },
  Dm: { arp: [38, 45, 53, 57, 60, 57, 53, 45], pad: [53, 57, 60, 62], root: 38 },
  Em: { arp: [40, 47, 55, 59, 62, 59, 55, 47], pad: [55, 59, 62, 64], root: 40 },
};
const phrases = {
  verse: ["C", "Am", "F", "G"],
  turn: ["Dm", "Em", "F", "G"],
};
// The melody, a bar at a time: [note, beats].
const tunes = {
  first: [[[76, 2], [79, 1], [76, 1]], [[72, 2], [76, 1], [74, 1]], [[72, 3], [69, 1]], [[71, 2], [74, 2]]],
  second: [[[76, 2], [79, 1], [83, 1]], [[81, 2], [79, 1], [76, 1]], [[77, 1], [76, 1], [72, 2]], [[74, 4]]],
  turn: [[[77, 2], [81, 2]], [[79, 2], [76, 2]], [[81, 1], [79, 1], [77, 1], [76, 1]], [[74, 3], [71, 1]]],
};

// Phrases are counted back from the peak, so the last one ends on G just as the day comes good.
const peakBar = Math.max(4, Math.floor(peak / bar));
const plan = [];
const cycle = [["verse", null], ["verse", "first"], ["verse", "second"], ["turn", "turn"]];
for (let start = peakBar - 4; start >= 2; start -= 4) plan.unshift(start);
const intro = plan[0];
plan.forEach((start, index) => {
  // The first two phrases have no tune; then it comes and goes.
  const [kind, tune] = index === 0 ? ["verse", null] : cycle[(index - 1) % cycle.length];
  phrases[kind].forEach((name, k) => playBar(start + k, name, tune ? tunes[tune][k] : null, (start + k) / peakBar));
});

function playBar(index, name, tune, progressToPeak) {
  const at = index * bar;
  const chord = chords[name];
  const strength = 0.55 + 0.45 * Math.pow(Math.min(1, progressToPeak), 1.6);
  pad(at, chord.pad, bar, 0.035 * strength);
  bass(at, chord.root, 0.12 * strength);
  if (strength > 0.7) bass(at + beat * 2, chord.root, 0.08 * strength);
  // Quarter notes while it is quiet, eighths as it grows.
  const step = strength > 0.72 ? 0.5 : 1;
  for (let k = 0; k < 8; k += step * 2) piano(at + k * beat * 0.5, chord.arp[k], 0.1 * strength, beat * 1.6);
  if (step === 0.5) for (let k = 1; k < 8; k += 2) piano(at + k * beat * 0.5, chord.arp[k], 0.07 * strength, beat);
  if (tune) {
    let beatAt = 0;
    for (const [midi, beats] of tune) { piano(at + beatAt * beat, midi, 0.16 * strength, beats * beat); if (strength > 0.85) piano(at + beatAt * beat, midi - 12, 0.06, beats * beat); beatAt += beats; }
  }
}

// Before the first phrase, the pad alone with a few notes.
for (let index = 0; index < intro; index++) {
  pad(index * bar, chords.C.pad, bar, 0.026);
  piano(index * bar + beat, 64, 0.06);
  piano(index * bar + beat * 3, 67, 0.05);
}

// The landing: C, with bells, then F and back to C, held and fading to the end.
const landing = peakBar * bar;
const coda = [["C", 2], ["F", 1], ["C", 99]];
let codaAt = landing;
for (const [name, bars] of coda) {
  const seconds = Math.min(bars * bar, length + 2 - codaAt);
  if (seconds <= 0) break;
  const chord = chords[name];
  pad(codaAt, chord.pad.concat(chord.pad[0] + 12), seconds, 0.04);
  bass(codaAt, chord.root, 0.13);
  for (let k = 0; k < Math.floor(seconds / beat); k++) piano(codaAt + k * beat, chord.arp[(k * 2) % 8] + (k % 4 === 3 ? 12 : 0), 0.09 * Math.max(0.4, 1 - (codaAt + k * beat - landing) / 20), beat * 1.8);
  codaAt += seconds;
}
bell(landing, 84, 0.08);
bell(landing + beat, 88, 0.06);
bell(landing + beat * 2, 91, 0.05);
bell(landing + bar * 3, 84, 0.05);

/** A plain room reverb: four damped echoes in parallel, two diffusers after them. */
function reverb(input, spread) {
  const out = new Float32Array(input.length);
  for (const delay of [1557, 1617, 1491, 1422].map((d) => d + spread)) {
    const buffer = new Float32Array(delay);
    let index = 0;
    let low = 0;
    for (let i = 0; i < input.length; i++) {
      const echo = buffer[index];
      low = echo * 0.75 + low * 0.25;
      buffer[index] = input[i] + low * 0.85;
      out[i] += echo * 0.25;
      index = (index + 1) % delay;
    }
  }
  for (const delay of [556 + spread, 441 + spread]) {
    const buffer = new Float32Array(delay);
    let index = 0;
    for (let i = 0; i < out.length; i++) {
      const held = buffer[index];
      const value = out[i];
      buffer[index] = value + held * 0.5;
      out[i] = held - value * 0.5;
      index = (index + 1) % delay;
    }
  }
  return out;
}
const wetLeft = reverb(left, 0);
const wetRight = reverb(right, 23);
let loudest = 0;
const mixed = [new Float32Array(total), new Float32Array(total)];
for (let i = 0; i < total; i++) {
  const fadeOut = Math.min(1, Math.max(0, (length - i / rate) / 3));
  mixed[0][i] = Math.tanh((left[i] + wetLeft[i] * 0.9) * 1.2) * fadeOut;
  mixed[1][i] = Math.tanh((right[i] + wetRight[i] * 0.9) * 1.2) * fadeOut;
  loudest = Math.max(loudest, Math.abs(mixed[0][i]), Math.abs(mixed[1][i]));
}

// A 16-bit stereo WAV, then an MP3 of it.
const samples = Math.ceil(length * rate);
const wav = Buffer.alloc(44 + samples * 4);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples * 4, 4); wav.write("WAVE", 8); wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(samples * 4, 40);
const scale = 0.89 / loudest;
for (let i = 0; i < samples; i++) {
  wav.writeInt16LE(Math.round(mixed[0][i] * scale * 32767), 44 + i * 4);
  wav.writeInt16LE(Math.round(mixed[1][i] * scale * 32767), 46 + i * 4);
}
const work = await mkdtemp(path.join(os.tmpdir(), "jb-score-"));
try {
  await writeFile(path.join(work, "score.wav"), wav);
  await promisify(execFile)("ffmpeg", ["-y", "-v", "error", "-i", path.join(work, "score.wav"), "-c:a", "libmp3lame", "-q:a", "2", output]);
} finally {
  await rm(work, { recursive: true, force: true });
}
// The film starts the score this much after its first frame, so the landing falls on the peak.
console.log(`${output}: ${length.toFixed(1)} s, lands at ${landing.toFixed(2)} s; start it ${(peak - landing).toFixed(2)} s in`);
