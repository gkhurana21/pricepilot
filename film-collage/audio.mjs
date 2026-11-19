// The soundtrack, made from nothing but arithmetic: a felt-piano bed, paper / pencil / stamp sounds on
// the picture's own cues, and the narration clips on top. No samples, no downloaded music.
//
//   node audio.mjs            writes out/audio/mix.wav (48 kHz stereo) and prints loudness figures
//
// Times come from src/timeline.js, the same clock the picture uses, and the cue lists live beside each
// scene's drawing code (src/scenes/*.js: cues()), so a sound cannot drift from the thing it belongs to.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTimeline, checkTimeline } from "./src/timeline.js";
import { mulberry } from "./src/lib/util.js";
import * as lever from "./src/scenes/lever.js";
import * as stall from "./src/scenes/stall.js";
import * as stamps from "./src/scenes/stamps.js";
import * as apply from "./src/scenes/apply.js";
import * as scroll from "./src/scenes/scroll.js";
import * as card from "./src/scenes/card.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const SR = 48000;
const OUT = path.join(HERE, "out/audio");
const TARGET_LUFS = -16, CEILING_DB = -2.0;   // integrated loudness aimed for; sample-peak ceiling (true peak lands a little above it)
fs.mkdirSync(OUT, { recursive: true });

const clips = JSON.parse(fs.readFileSync(path.join(HERE, "assets/audio/clips.json"), "utf8"));
const tl = buildTimeline(clips);
for (const p of checkTimeline(tl)) console.warn("timeline:", p);
const N = Math.ceil(tl.duration * SR);
const TAU = Math.PI * 2;
const db = (x) => 10 ** (x / 20);

// ---------- small DSP kit ----------

const buf = (n = N) => new Float32Array(n);
const stereo = (n = N) => [buf(n), buf(n)];

function onePoleLP(x, hz) { const a = 1 - Math.exp((-TAU * hz) / SR); let y = 0; for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); x[i] = y; } return x; }
function onePoleHP(x, hz) { const a = 1 - Math.exp((-TAU * hz) / SR); let y = 0; for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); x[i] -= y; } return x; }
const band = (x, lo, hi) => onePoleLP(onePoleLP(onePoleHP(onePoleHP(x, lo), lo), hi), hi);
function noise(n, seed) { const r = mulberry(seed), x = buf(n); for (let i = 0; i < n; i++) x[i] = r() * 2 - 1; return x; }

// Add mono x into stereo bus at time t with gain g and pan (-1..1), equal power.
function place(bus, x, t, g = 1, pan = 0) {
  const i0 = Math.round(t * SR), gl = g * Math.cos(((pan + 1) * Math.PI) / 4), gr = g * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < x.length; i++) { const j = i0 + i; if (j < 0 || j >= N) continue; bus[0][j] += x[i] * gl; bus[1][j] += x[i] * gr; }
}

// A small room: four damped combs and two all-passes per side, slightly different left and right.
function reverb(inL, inR, { wet = 0.2, decay = 0.78, damp = 0.35 } = {}) {
  const out = stereo(inL.length);
  const tap = [[1557, 1617, 1491, 1422], [1583, 1651, 1513, 1447]], ap = [[225, 556], [241, 579]];
  for (let ch = 0; ch < 2; ch++) {
    const x = ch === 0 ? inL : inR, y = out[ch], acc = buf(x.length);
    for (const d0 of tap[ch]) {
      const d = Math.round((d0 * SR) / 44100), line = buf(d);
      let k = 0, lp = 0;
      for (let i = 0; i < x.length; i++) { const o = line[k]; lp = o * (1 - damp) + lp * damp; line[k] = x[i] + lp * decay; acc[i] += o; if (++k >= d) k = 0; }
    }
    for (const d0 of ap[ch]) {
      const d = Math.round((d0 * SR) / 44100), line = buf(d);
      let k = 0;
      for (let i = 0; i < acc.length; i++) { const b = line[k], v = acc[i] + b * 0.5; line[k] = v; acc[i] = b - v * 0.5; if (++k >= d) k = 0; }
    }
    for (let i = 0; i < x.length; i++) y[i] = acc[i] * wet * 0.25;
  }
  return out;
}

// ---------- the piano: soft hammers, felt between hammer and string ----------

const midi = (m) => 440 * 2 ** ((m - 69) / 12);

// One note: a few decaying partials (each a damped resonator, so it costs two multiplies a sample),
// duller and longer the lower it is, with the faint knock of the action under it.
function pianoNote(m, vel, hold, seed) {
  const f = midi(m), r = mulberry(seed);
  const tail = 1.1, n = Math.ceil((hold + tail) * SR), x = buf(n);
  const t1 = Math.min(5.5, 2.6 * (261.6 / f) ** 0.55);       // decay time of the fundamental
  const bright = 0.72 + 0.4 * vel;                           // soft playing has fewer upper partials
  for (let k = 1; k <= 7; k++) {
    const fk = f * k * Math.sqrt(1 + 0.00035 * k * k);
    if (fk > 5200) break;
    const amp = (vel * Math.exp(-(k - 1) / (1.9 * bright))) / k ** 0.6;
    const tau = t1 / (1 + 0.75 * (k - 1));
    for (const det of [-0.0006, 0.0007]) {
      const w = (TAU * fk * (1 + det)) / SR, rr = Math.exp(-1 / (tau * SR));
      const c = 2 * rr * Math.cos(w);
      let y1 = 0, y2 = -Math.sin(w + r() * 0.2) * amp * 0.5 * rr;   // start on a sine at zero phase
      for (let i = 0; i < n; i++) { const y = c * y1 - rr * rr * y2; y2 = y1; y1 = y; x[i] += y; }
    }
  }
  // attack: a few milliseconds of rise so there is no click; release: the damper comes down softly
  const att = Math.round(0.009 * SR), rel0 = Math.round(hold * SR);
  for (let i = 0; i < att; i++) x[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / att);
  for (let i = rel0; i < n; i++) x[i] *= Math.exp(-(i - rel0) / (0.32 * SR));
  // the action
  const kn = onePoleLP(noise(Math.round(0.05 * SR), seed + 1), 420);
  for (let i = 0; i < kn.length; i++) x[i] += kn[i] * vel * 0.25 * Math.exp(-i / (0.012 * SR));
  return onePoleLP(x, 2600 + 2400 * vel);
}

function music() {
  const dry = stereo(), r = mulberry(4242);
  // The last chord lands as the name appears on the closing card. The number of bars is the multiple
  // of four (one turn of the chords) that keeps a bar closest to three and a half seconds, so the
  // piece keeps its pace whatever the film's length.
  const land = card.events(tl).name;
  const BARS = [16, 20, 24, 28, 32].reduce((a, b) => (Math.abs(land / b - 3.5) < Math.abs(land / a - 3.5) ? b : a));
  const bar = land / BARS, beat = bar / 4;
  const prog = [
    { bass: 53, tones: [57, 60, 64, 67] },   // F maj7   (the left hand stays in the tenor octave:
    { bass: 50, tones: [57, 60, 65, 69] },   // D min7    low piano notes under a voice only make mud)
    { bass: 46, tones: [58, 62, 65, 69] },   // Bb maj7
    { bass: 48, tones: [55, 60, 64, 69] },   // C 6
  ];
  const arp = [0, 1, 2, 1, 3, 1, 2, 1];
  // [bar within the phrase, beat, midi, beats held]: a small rising, falling phrase and its answer
  const phraseA = [[0, 0, 72, 2], [0, 2.5, 69, 1.5], [1, 0, 74, 1.5], [1, 2, 72, 2], [2, 0, 70, 1.5], [2, 2, 69, 1], [2, 3, 67, 1], [3, 0, 67, 3]];
  const phraseB = [[0, 0, 76, 2], [0, 2.5, 72, 1.5], [1, 0, 77, 1.5], [1, 2, 74, 2], [2, 0, 74, 1.5], [2, 2, 72, 1], [2, 3, 70, 1], [3, 0, 72, 3]];
  const close = [[0, 0, 77, 2], [0, 2.5, 76, 1.5], [1, 0, 74, 2], [1, 2, 72, 1], [1, 3, 67, 1]];
  const tune = [];
  for (let b = 2, k = 0; b + 4 <= BARS - 2; b += 4, k++) for (const [db, bt, m, len] of k % 2 ? phraseB : phraseA) tune.push([b + db, bt, m, len]);
  for (const [db, bt, m, len] of close) tune.push([BARS - 2 + db, bt, m, len]);
  let seed = 1;
  const play = (m, t, vel, hold, pan) => place(dry, pianoNote(m, vel, hold, seed++), t + (r() - 0.5) * 0.014, 1, pan);
  for (let b = 0; b < BARS; b++) {
    const ch = prog[b % 4], t0 = b * bar, quiet = b < 1 ? 0.75 : 1;
    play(ch.bass, t0, 0.3 * quiet, bar * 0.95, -0.15);
    if (b % 2 === 1) play(ch.bass + 7, t0 + beat * 2, 0.2, beat * 1.9, -0.1);
    for (let k = 0; k < 8; k++) {
      if (b === 0 && k % 2 === 1) continue;                    // the first bar is only half as busy
      const accent = k === 0 ? 0.36 : k === 4 ? 0.32 : 0.24 + r() * 0.05;
      play(ch.tones[arp[k]], t0 + k * (beat / 2), accent * quiet, beat * 1.4, 0.12 + 0.1 * (arp[k] - 1.5) / 1.5);
    }
  }
  for (const [b, bt, m, len] of tune) play(m, b * bar + bt * beat, 0.4 + r() * 0.06, len * beat * 1.05, 0.22);
  // the last chord, spread from the bottom up and left to ring
  [41, 48, 53, 57, 60, 64, 67, 72].forEach((m, i) => play(m, land + i * 0.055, i < 2 ? 0.3 : 0.36, 5.5, (i - 3.5) / 9));
  const wet = reverb(dry[0], dry[1], { wet: 0.34, decay: 0.83, damp: 0.42 });
  for (let ch = 0; ch < 2; ch++) { for (let i = 0; i < N; i++) dry[ch][i] = dry[ch][i] * 0.8 + wet[ch][i]; onePoleHP(onePoleHP(dry[ch], 85), 85); }
  // fade in over the first third of a second, out over the last two
  for (let ch = 0; ch < 2; ch++) for (let i = 0; i < N; i++) {
    const t = i / SR;
    dry[ch][i] *= Math.min(1, t / 0.3) * Math.min(1, (tl.duration - t) / 2.2);
  }
  return dry;
}

// ---------- paper, pencil, wood, rubber ----------

const env = (x, a, r) => { const na = Math.round(a * SR), n = x.length, nr = Math.round(r * SR); for (let i = 0; i < n; i++) x[i] *= Math.min(1, i / na) * Math.min(1, (n - i) / nr); return x; };
const lenOf = (s) => Math.round(s * SR);

const FX = {
  // a sheet drawn across the desk
  slide(seed, d = 0.75) {
    const n = lenOf(d), x = band(noise(n, seed), 500, 3800), r = mulberry(seed + 1);
    let w = 0; const wob = buf(n); for (let i = 0; i < n; i++) { if (i % 480 === 0) w = 0.6 + r() * 0.4; wob[i] = w; }
    onePoleLP(wob, 30);
    for (let i = 0; i < n; i++) { const u = i / n; x[i] *= Math.sin(Math.PI * u) ** 1.4 * wob[i]; }
    return x;
  },
  // a piece of paper handled
  paper(seed) {
    const n = lenOf(0.22), x = band(noise(n, seed), 1400, 6500);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] *= Math.exp(-t / 0.03) + 0.7 * Math.exp(-((t - 0.09) ** 2) / 0.0006) + 0.4 * Math.exp(-((t - 0.15) ** 2) / 0.0005); }
    return x;
  },
  // a tag turned over
  flip(seed) {
    const n = lenOf(0.34), x = band(noise(n, seed), 900, 5200);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] *= 0.9 * Math.exp(-((t - 0.05) ** 2) / 0.0009) + 0.7 * Math.exp(-((t - 0.19) ** 2) / 0.0014); }
    const low = onePoleLP(noise(n, seed + 2), 240);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] += low[i] * 1.2 * Math.exp(-((t - 0.12) ** 2) / 0.004); }
    return x;
  },
  // pencil on paper, for d seconds: short uneven strokes
  scratch(seed, d = 0.5) {
    const n = lenOf(d), x = band(noise(n, seed), 1900, 5200), r = mulberry(seed + 3), e = buf(n);
    let t = 0;
    while (t < d) { const len = 0.05 + r() * 0.09, gap = 0.015 + r() * 0.03, amp = 0.6 + r() * 0.4; const i0 = lenOf(t), m = lenOf(len); for (let i = 0; i < m && i0 + i < n; i++) e[i0 + i] = amp * Math.sin((Math.PI * i) / m) ** 0.7; t += len + gap; }
    onePoleLP(e, 60);
    for (let i = 0; i < n; i++) x[i] *= e[i];
    return env(x, 0.01, 0.03);
  },
  tick(seed) { return FX.scratch(seed, 0.11); },
  // a rubber stamp coming down on paper on a desk
  stamp(seed) {
    const n = lenOf(0.3), x = buf(n);
    let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / SR, f = 62 + 46 * Math.exp(-t / 0.03); ph += (TAU * f) / SR; x[i] = Math.sin(ph) * Math.exp(-t / 0.07) * 0.95; }
    const c = onePoleLP(noise(n, seed), 1500);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] += c[i] * 0.85 * Math.exp(-t / 0.013) + c[i] * 0.16 * Math.exp(-((t - 0.07) ** 2) / 0.0008); }
    return env(x, 0.002, 0.03);
  },
  // a heavy book set down
  thump(seed) {
    const n = lenOf(0.45), x = buf(n);
    let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / SR, f = 48 + 34 * Math.exp(-t / 0.04); ph += (TAU * f) / SR; x[i] = Math.sin(ph) * Math.exp(-t / 0.11); }
    const c = onePoleLP(noise(n, seed), 700);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] += c[i] * 0.9 * Math.exp(-t / 0.025); }
    return env(x, 0.003, 0.05);
  },
  // wood on wood, small
  knock(seed) {
    const n = lenOf(0.16), x = buf(n), c = onePoleLP(noise(n, seed), 2500);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] = (Math.sin(TAU * 310 * t) * 0.7 + Math.sin(TAU * 742 * t) * 0.25) * Math.exp(-t / 0.028) + c[i] * 0.4 * Math.exp(-t / 0.006); }
    return env(x, 0.001, 0.02);
  },
  // something light touching down
  tap(seed) {
    const n = lenOf(0.1), x = buf(n), c = onePoleLP(noise(n, seed), 3200);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] = Math.sin(TAU * 520 * t) * 0.45 * Math.exp(-t / 0.016) + c[i] * 0.5 * Math.exp(-t / 0.007); }
    return env(x, 0.001, 0.02);
  },
  click(seed) {
    const n = lenOf(0.12), x = buf(n), c = onePoleLP(noise(n, seed), 1800);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] = Math.sin(TAU * 190 * t) * 0.8 * Math.exp(-t / 0.022) + c[i] * 0.6 * Math.exp(-t / 0.005) + c[i] * 0.3 * Math.exp(-((t - 0.07) ** 2) / 0.00002); }
    return env(x, 0.001, 0.02);
  },
  // air moved by something passing; also the long arm swinging
  whoosh(seed, d = 0.42) {
    const n = lenOf(d), src = noise(n, seed), x = buf(n);
    let lp = 0, lp2 = 0;
    for (let i = 0; i < n; i++) { const u = i / n, a = 1 - Math.exp((-TAU * (260 + 1100 * Math.sin(Math.PI * u))) / SR); lp += a * (src[i] - lp); lp2 += a * (lp - lp2); x[i] = lp2 * Math.sin(Math.PI * u) ** 2; }
    return onePoleHP(x, 140);
  },
  creak(seed) { return FX.whoosh(seed, 0.6); },
  // a soft "bloop" for something appearing
  pop() {
    const n = lenOf(0.14), x = buf(n);
    let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / SR, f = 300 + 380 * (1 - Math.exp(-t / 0.02)); ph += (TAU * f) / SR; x[i] = Math.sin(ph) * Math.exp(-t / 0.035); }
    return env(x, 0.004, 0.03);
  },
  // the helper: two small rising notes, quiet and round
  chirp(seed) {
    const n = lenOf(0.3), x = buf(n), r = mulberry(seed);
    for (const [t0, f0, f1] of [[0, 2350, 3050], [0.13, 2700, 3400]]) {
      let ph = 0;
      const d = 0.085 + r() * 0.02, i0 = lenOf(t0), m = lenOf(d);
      for (let i = 0; i < m; i++) { const u = i / m, f = f0 + (f1 - f0) * u ** 0.6 + 60 * Math.sin(u * 40); ph += (TAU * f) / SR; x[i0 + i] += (Math.sin(ph) + 0.18 * Math.sin(2 * ph)) * Math.sin(Math.PI * u) ** 1.5; }
    }
    return x;
  },
  // wings
  flutter(seed, d = 0.9) {
    const n = lenOf(d), x = band(noise(n, seed), 300, 2200);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] *= Math.max(0, Math.sin(TAU * 5.2 * t)) ** 3 * Math.sin((Math.PI * i) / n) ** 0.6; }
    return x;
  },
  // paper coming off a roll
  unroll(seed, d = 0.9) {
    const n = lenOf(d), x = band(noise(n, seed), 1100, 4200), r = mulberry(seed + 5), e = buf(n);
    let k = 0;
    for (let i = 0; i < n; i++) { if (i >= k) { const m = lenOf(0.018 + r() * 0.03); for (let j = 0; j < m && i + j < n; j++) e[i + j] = (0.4 + r() * 0.6) * Math.exp(-j / (m * 0.4)); k = i + m; } }
    for (let i = 0; i < n; i++) x[i] *= e[i] * Math.sin((Math.PI * i) / n) ** 0.5;
    return x;
  },
  tape(seed) {
    const n = lenOf(0.12), x = band(noise(n, seed), 2200, 7000), low = onePoleLP(noise(n, seed + 1), 300);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] = x[i] * Math.exp(-t / 0.018) + low[i] * 0.8 * Math.exp(-t / 0.03); }
    return x;
  },
  // a small bright bar struck softly (in the key of the music)
  ding(seed) {
    const n = lenOf(1.4), x = buf(n), f = seed % 2 ? 1046.5 : 880;
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] = Math.sin(TAU * f * t) * Math.exp(-t / 0.33) + 0.32 * Math.sin(TAU * f * 2.76 * t) * Math.exp(-t / 0.09) + 0.12 * Math.sin(TAU * f * 5.4 * t) * Math.exp(-t / 0.035); }
    return env(x, 0.003, 0.05);
  },
};
const LEVEL = { slide: 0.5, paper: 0.42, flip: 0.5, scratch: 0.3, tick: 0.34, stamp: 0.8, thump: 0.85, knock: 0.36, tap: 0.3, click: 0.5, whoosh: 0.5, creak: 0.4, pop: 0.26, chirp: 0.085, flutter: 0.4, unroll: 0.26, tape: 0.34, ding: 0.085 };

function foley() {
  const bus = stereo();
  const mods = { lever, stall, stamps, apply, scroll, card };
  const list = [];
  for (const sc of tl.scenes) for (const c of mods[sc.id].cues(tl, sc)) list.push({ ...c, scene: sc.id });
  list.sort((a, b) => a.t - b.t);
  list.forEach((c, i) => {
    if (!FX[c.s]) throw new Error(`no sound called ${c.s}`);
    const x = FX[c.s](1000 + i * 7, c.d);
    // a little left or right by scene position would be guesswork; keep effects near the centre
    place(bus, x, c.t, (c.g ?? 1) * LEVEL[c.s], ((i * 37) % 9 - 4) / 14);
  });
  const wet = reverb(bus[0], bus[1], { wet: 0.16, decay: 0.7, damp: 0.5 });
  for (let ch = 0; ch < 2; ch++) for (let i = 0; i < N; i++) bus[ch][i] += wet[ch][i];
  return { bus, list };
}

// ---------- narration ----------

function readWav(file) {
  const raw = path.join(OUT, "tmp.f32");
  execFileSync(FFMPEG, ["-y", "-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", raw]);
  const b = fs.readFileSync(raw);
  fs.unlinkSync(raw);
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice();
}

function narration() {
  const mono = buf();
  for (const [id, line] of Object.entries(tl.lines)) {
    const x = onePoleHP(readWav(path.join(HERE, "assets/audio", line.file)), 70);
    env(x, 0.004, 0.02);
    const i0 = Math.round(line.start * SR);
    for (let i = 0; i < x.length && i0 + i < N; i++) mono[i0 + i] += x[i];
    void id;
  }
  // bring the voice to a steady level: scale so its loudest 50 ms window sits at a known value
  let peakRms = 0;
  const win = Math.round(0.05 * SR);
  for (let i = 0; i + win < N; i += win) { let s = 0; for (let j = 0; j < win; j++) s += mono[i + j] ** 2; peakRms = Math.max(peakRms, Math.sqrt(s / win)); }
  const g = 0.3 / (peakRms || 1);
  for (let i = 0; i < N; i++) mono[i] *= g;
  return compress(mono);
}

// A gentle compressor for the voice (2.5:1 above -18 dBFS, soft knee), so that its peaks are tamed by
// something slow and musical and the limiter at the end has almost nothing to do.
function compress(x, { thr = -18, ratio = 2.5, knee = 8, att = 0.004, rel = 0.11 } = {}) {
  const a = 1 - Math.exp(-1 / (att * SR)), r = 1 - Math.exp(-1 / (rel * SR));
  let e = 0, maxGr = 0;
  const la = Math.round(0.003 * SR), out = buf(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[Math.min(x.length - 1, i + la)]);
    e += (v > e ? a : r) * (v - e);
    const lvl = 20 * Math.log10(e + 1e-9), over = lvl - thr;
    let gr = 0;
    if (over > knee / 2) gr = over * (1 - 1 / ratio);
    else if (over > -knee / 2) gr = ((over + knee / 2) ** 2 / (2 * knee)) * (1 - 1 / ratio);
    maxGr = Math.max(maxGr, gr);
    out[i] = x[i] * 10 ** (-gr / 20);
  }
  compress.maxGr = maxGr;
  return out;
}

// How much to hold the music down: follows the voice, quick to duck, slow to come back. The return
// takes well over a second, so that between phrases a few seconds apart the music swells gently
// instead of jumping up and being pushed down again.
function duckCurve(voice, depthDb = -8.5) {
  const e = buf(), g = buf();
  let a = 0;
  const up = 1 - Math.exp(-1 / (0.06 * SR)), down = 1 - Math.exp(-1 / (1.5 * SR));
  for (let i = 0; i < N; i++) { const v = Math.abs(voice[i]) > 0.012 ? 1 : 0; a += (v > a ? up : down) * (v - a); e[i] = a; }
  // look ahead 90 ms so the music is already down when the word starts
  const la = Math.round(0.09 * SR), lo = db(depthDb);
  for (let i = 0; i < N; i++) { const k = e[Math.min(N - 1, i + la)]; g[i] = 1 + (lo - 1) * Math.min(1, k * 1.15); }
  return onePoleLP(g, 6);
}

// A look-ahead peak limiter: the gain is already down when a peak arrives, moves without steps, and
// recovers over about a tenth of a second. Returns the fraction of samples it touched.
function limit(L, R, ceilingDb) {
  const c = db(ceilingDb), la = Math.round(0.005 * SR), n = L.length, need = buf(n).fill(1);
  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (p > c) { const r = c / p; for (let j = Math.max(0, i - la); j <= Math.min(n - 1, i + la); j++) if (r < need[j]) need[j] = r; }
  }
  // moving average over the look-ahead window: ramps instead of steps, and never above what is needed
  const g = buf(n), h = la >> 1;
  let sum = 0;
  for (let i = -h; i < n; i++) {
    const add = i + h < n ? need[i + h] : 1, drop = i - h - 1 >= 0 ? need[i - h - 1] : 1;
    sum += add - (i > -h ? drop : 0);
    if (i === -h) sum = add + h * 1 + h;        // window starts full of ones
    if (i >= 0) g[i] = Math.min(1, sum / (2 * h + 1));
  }
  let cur = 1, touched = 0, deepest = 1;
  const rel = 1 - Math.exp(-1 / (0.1 * SR));
  for (let i = 0; i < n; i++) {
    cur = Math.min(g[i], cur + rel * (1 - cur));
    L[i] *= cur; R[i] *= cur;
    if (cur < 0.944) touched++;                  // more than half a decibel of reduction
    if (cur < deepest) deepest = cur;
  }
  return { fraction: touched / n, deepestDb: 20 * Math.log10(deepest) };
}

function writeWav(file, L, R) {
  const n = L.length, b = Buffer.alloc(44 + n * 4);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 4, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 4, 40);
  // triangular dither, seeded
  const r = mulberry(9);
  for (let i = 0; i < n; i++) {
    const d = (r() - r()) / 65536;
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((L[i] + d) * 32767))), 44 + i * 4);
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((R[i] + d) * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(file, b);
}

export function measure(file) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"], { encoding: "utf8" });
  const s = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  return { I: Number(/I:\s+(-?[\d.]+) LUFS/.exec(s)?.[1]), LRA: Number(/LRA:\s+(-?[\d.]+) LU/.exec(s)?.[1]), truePeak: Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(s)?.[1]) };
}

// ---------- build ----------

const t0 = Date.now();
const voice = narration();
const mus = music();
const { bus: fx, list } = foley();
const duck = duckCurve(voice);
const file = path.join(OUT, "mix.wav");
const stem = (name, L, R) => { const f = path.join(OUT, `${name}.wav`); writeWav(f, L, R); return measure(f); };
const scaled = (x, g, curve) => x.map((v, i) => v * g * (curve ? curve[i] : 1));

// Balance by measurement, relative to the voice: the music sits MUSIC_BELOW LU under it when nobody
// is speaking and a further DUCK dB under while they are; the loudest effect peaks FOLEY_PEAK_BELOW dB
// under the voice's own peak.
const MUSIC_BELOW = 8.5, FOLEY_PEAK_BELOW = 7.5;
const v0 = stem("stem-voice", voice, voice);
const m0 = stem("stem-music", scaled(mus[0], 0.05), scaled(mus[1], 0.05));
const f0 = stem("stem-foley", scaled(fx[0], 0.05), scaled(fx[1], 0.05));
const MUSIC = 0.05 * db(v0.I - MUSIC_BELOW - m0.I), FOLEY = 0.05 * db(v0.truePeak - FOLEY_PEAK_BELOW - f0.truePeak);
const preL = buf(), preR = buf();
for (let i = 0; i < N; i++) {
  const m = MUSIC * duck[i], f = FOLEY * (0.8 + 0.2 * duck[i]);
  preL[i] = voice[i] + mus[0][i] * m + fx[0][i] * f;
  preR[i] = voice[i] + mus[1][i] * m + fx[1][i] * f;
}
// set the level by measurement: scale, limit, measure, correct, until the mix sits on the target
let gain = 1, m = null, limited = null;
for (let pass = 0; pass < 6; pass++) {
  const L = preL.map((v) => v * gain), R = preR.map((v) => v * gain);
  limited = limit(L, R, CEILING_DB);
  writeWav(file, L, R);
  m = measure(file);
  if (Math.abs(m.I - TARGET_LUFS) < 0.06) break;
  gain *= db(TARGET_LUFS - m.I);
}
// stems, for checking the balance by measurement
const mv = stem("stem-voice", scaled(voice, gain), scaled(voice, gain));
const mm = stem("stem-music", scaled(mus[0], MUSIC * gain, duck), scaled(mus[1], MUSIC * gain, duck));
const mu = stem("stem-music-unducked", scaled(mus[0], MUSIC * gain), scaled(mus[1], MUSIC * gain));
const mf = stem("stem-foley", scaled(fx[0], FOLEY * gain), scaled(fx[1], FOLEY * gain));
const report = {
  duration: Number(tl.duration.toFixed(3)), cues: list.length, narration: clips.voice,
  mix: m,
  voice_compressor_max_reduction_dB: Number(compress.maxGr.toFixed(1)),
  limiter: { fraction_of_time_reducing_more_than_half_a_dB: Number(limited.fraction.toFixed(4)), deepest_reduction_dB: Number(limited.deepestDb.toFixed(2)) },
  master_gain_dB: Number((20 * Math.log10(gain)).toFixed(2)),
  stems_integrated_LUFS: { voice: mv.I, music_as_mixed: mm.I, music_if_never_ducked: mu.I, foley: mf.I },
  stems_true_peak_dBFS: { voice_before_limiter: mv.truePeak, music_as_mixed: mm.truePeak, foley: mf.truePeak },
  built_in_ms: Date.now() - t0,
};
fs.writeFileSync(path.join(OUT, "audio-report.json"), JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(path.join(OUT, "cues.json"), JSON.stringify(list.map((c) => ({ t: Number(c.t.toFixed(3)), sound: c.s, scene: c.scene })), null, 1) + "\n");
console.log(JSON.stringify(report, null, 2));
