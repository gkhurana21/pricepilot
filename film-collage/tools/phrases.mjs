// Cuts a narration clip into its phrases, so the picture can be given time between them.
// Nothing is re-synthesised and no speech is altered: each cut is made inside a pause the voice
// itself left (the longest ones in the clip), at a zero crossing, with a few milliseconds of fade.
//
//   node tools/phrases.mjs          cuts the lines listed in src/script.js under CUTS
//
// The whole clips are kept in assets/audio/whole/ (copied there the first time), the phrases are
// written to assets/audio/line-<id>.wav, and clips.json gets one entry per phrase.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LINES, CUTS } from "../src/script.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIO = path.join(HERE, "../assets/audio"), WHOLE = path.join(AUDIO, "whole");
const FF = "/opt/homebrew/bin/ffmpeg", SR = 48000;
const TAIL = 0.11, HEAD = 0.05;     // kept after a phrase's last sound and before the next one's first
fs.mkdirSync(WHOLE, { recursive: true });

const read = (file) => {
  const b = execFileSync(FF, ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice();
};
function write(file, x) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, b);
}
function pauses(file) {
  const r = spawnSync(FF, ["-hide_banner", "-i", file, "-af", "silencedetect=noise=-34dB:d=0.12", "-f", "null", "-"], { encoding: "utf8" });
  const s = [...r.stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1])), e = [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  return s.map((a, i) => [a, e[i] ?? a]).filter(([a, b]) => b > a);
}
// nearest sample to i where the signal crosses zero (within 4 ms)
function zero(x, i) {
  for (let d = 0; d < SR * 0.004; d++) for (const j of [i + d, i - d]) if (j > 0 && j < x.length && (x[j - 1] <= 0) !== (x[j] <= 0)) return j;
  return i;
}
const rmsDb = (x, i, n = SR * 0.01) => { let s = 0, c = 0; for (let j = Math.max(0, i - n); j < Math.min(x.length, i + n); j++) { s += x[j] * x[j]; c++; } return 10 * Math.log10(s / c + 1e-12); };
const round = (v) => Number(v.toFixed(3));

const clips = JSON.parse(fs.readFileSync(path.join(AUDIO, "clips.json"), "utf8"));
for (const [whole, ids] of Object.entries(CUTS)) {
  const src = path.join(WHOLE, `line-${whole}.wav`);
  if (!fs.existsSync(src)) fs.copyFileSync(path.join(AUDIO, `line-${whole}.wav`), src);
  const x = read(src), dur = x.length / SR;
  const all = pauses(src).filter(([a, b]) => a > 0.1 && b < dur - 0.1);
  const at = [...all].sort((p, q) => (q[1] - q[0]) - (p[1] - p[0])).slice(0, ids.length - 1).sort((p, q) => p[0] - q[0]);
  if (at.length !== ids.length - 1) throw new Error(`line ${whole}: needed ${ids.length - 1} pauses, found ${at.length}`);
  console.log(`line ${whole}: ${dur.toFixed(3)} s; pauses ${all.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}`).join(", ")}; cutting in ${at.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}`).join(" and ")}`);
  let from = 0, total = 0;
  ids.forEach((id, k) => {
    const line = LINES.find((l) => l.id === id);
    if (!line || line.parts.length !== 1) throw new Error(`script.js: phrase ${id} must be a line with one part`);
    const p = at[k];
    // end: a little after the last sound, but never past the middle of the pause; start: a little before the next sound
    const end = k < at.length ? zero(x, Math.round(Math.min(p[0] + TAIL, (p[0] + p[1]) / 2) * SR)) : x.length;
    const y = x.slice(from, end);
    const fi = Math.round(0.005 * SR), fo = Math.round(0.008 * SR);
    if (k > 0) for (let i = 0; i < fi; i++) y[i] *= i / fi;
    if (k < at.length) for (let i = 0; i < fo; i++) y[y.length - 1 - i] *= i / fo;
    write(path.join(AUDIO, `line-${id}.wav`), y);
    const t0 = from / SR, d = y.length / SR;
    const inside = all.filter(([a, b]) => a > t0 + 0.05 && b < t0 + d - 0.05).map(([a, b]) => [round(a - t0), round(b - t0)]);
    clips.lines[id] = { file: `line-${id}.wav`, duration: round(d), located: `cut from line ${whole} (${t0.toFixed(3)} to ${(end / SR).toFixed(3)} s of it)`, parts: [{ id: line.parts[0].id, start: 0, end: round(d), text: line.parts[0].text }], pauses: inside };
    console.log(`  ${id}: ${t0.toFixed(3)} - ${(end / SR).toFixed(3)} s (${d.toFixed(3)} s)  "${line.parts[0].text}"` +
      (k < at.length ? `   level at the cut ${rmsDb(x, end).toFixed(0)} dBFS, sample there ${x[end].toFixed(5)}` : ""));
    total += d;
    if (k < at.length) from = zero(x, Math.round(Math.max(p[1] - HEAD, (p[0] + p[1]) / 2) * SR));
    if (k < at.length) console.log(`     next phrase starts at ${(from / SR).toFixed(3)} s: level ${rmsDb(x, from).toFixed(0)} dBFS; ${((from - end) / SR).toFixed(3)} s of the pause left out`);
  });
  console.log(`  phrases total ${total.toFixed(3)} s of ${dur.toFixed(3)} s`);
}
fs.writeFileSync(path.join(AUDIO, "clips.json"), JSON.stringify(clips, null, 2) + "\n");
