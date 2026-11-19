// Measures narration clips, since they cannot be listened to here: length, pauses (where and how long),
// peak and loudness, and the median pitch of the voiced parts.
//   node tools/voice-check.mjs out/audition/*.wav
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const FF = "/opt/homebrew/bin/ffmpeg";
for (const file of process.argv.slice(2)) {
  const raw = execFileSync(FF, ["-v", "error", "-i", file, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const dur = x.length / 16000;
  const r = spawnSync(FF, ["-hide_banner", "-nostats", "-i", file, "-af", "silencedetect=noise=-34dB:d=0.12,ebur128=peak=true:framelog=quiet", "-f", "null", "-"], { encoding: "utf8" });
  const st = [...r.stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1])), en = [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const pauses = st.map((s, i) => [s, (en[i] ?? dur) - s]).filter(([s, d]) => s > 0.05 && s + d < dur - 0.05);
  const sum = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const I = /I:\s+(-?[\d.]+) LUFS/.exec(sum)?.[1], peak = /Peak:\s+(-?[\d.]+) dBFS/.exec(sum)?.[1];
  // pitch: autocorrelation on 40 ms frames, 70-350 Hz, voiced frames only
  const f0 = [];
  for (let i = 0; i + 640 < x.length; i += 320) {
    let e = 0; for (let j = 0; j < 640; j++) e += x[i + j] ** 2;
    if (e / 640 < 0.0004) continue;
    let best = 0, lag = 0;
    for (let l = 46; l <= 228; l++) { let c = 0; for (let j = 0; j + l < 640; j++) c += x[i + j] * x[i + j + l]; c /= e; if (c > best) { best = c; lag = l; } }
    if (best > 0.45) f0.push(16000 / lag);
  }
  f0.sort((a, b) => a - b);
  const q = (p) => f0[Math.floor(p * (f0.length - 1))]?.toFixed(0);
  // noise floor: quietest 5% of 20 ms windows
  const rms = []; for (let i = 0; i + 320 < x.length; i += 320) { let e = 0; for (let j = 0; j < 320; j++) e += x[i + j] ** 2; rms.push(10 * Math.log10(e / 320 + 1e-12)); }
  rms.sort((a, b) => a - b);
  console.log(`${path.basename(file)}\n  ${dur.toFixed(2)} s, ${I} LUFS, true peak ${peak} dBFS, quietest windows ${rms[Math.floor(rms.length * 0.05)].toFixed(0)} dBFS`);
  console.log(`  pitch: median ${q(0.5)} Hz, middle 80% ${q(0.1)}-${q(0.9)} Hz`);
  console.log(`  pauses (start s: length s): ${pauses.map(([s, d]) => `${s.toFixed(2)}: ${d.toFixed(2)}`).join("   ")}`);
}
