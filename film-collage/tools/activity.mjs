// "Is something always happening?" Measured, frame by frame, from the film's own renderer.
//
// For every frame it draws the picture, shrinks it to 384 x 216 and compares it with the frame before:
//   action   at least 120 of those 82,944 pixels changed by more than 48 levels out of 255: something
//            sizeable moved (a print being dealt, a hand, a stamp, the bird, a sheet sliding, a real
//            camera move)
//   slow     the picture changed, but less than that (the camera creeping in, bunting, steam)
//   still    not one pixel changed
// The threshold was set by looking at the numbers: the camera creeping in on a page of small text
// flickers up to about 60 such pixels a frame (aliasing in the shrunken copy), while a hand or a print
// moving changes hundreds to thousands. A pencil stroke is too small to tell from that flicker this
// way, so the pencil is taken from the sound cues instead: every stroke has one, of its own length.
// "Nothing happening" below means: no voice, no action and no pencil.
// It lays that beside the voice (from the timeline) and the pencil (from the sound cues, which are
// placed on the strokes), prints a second-by-second table, and reports the longest stretch in which
// nobody is speaking and there is no action.
//
//   node tools/activity.mjs            measures (about six minutes) and writes out/evidence/activity.txt
//   node tools/activity.mjs --reuse    re-reads the last measurement (out/evidence/activity.json)
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../serve.mjs";
import { buildTimeline } from "../src/timeline.js";
import { LINES } from "../src/script.js";
import * as lever from "../src/scenes/lever.js";
import * as stall from "../src/scenes/stall.js";
import * as stamps from "../src/scenes/stamps.js";
import * as apply from "../src/scenes/apply.js";
import * as scroll from "../src/scenes/scroll.js";
import * as card from "../src/scenes/card.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tl = buildTimeline(JSON.parse(fs.readFileSync(path.join(HERE, "../assets/audio/clips.json"), "utf8")));
const FPS = 60, N = tl.frames;

const RAW = path.join(HERE, "../out/evidence/activity.json");
let changed = [0], strong = [0], mean = [0];
if (process.argv.includes("--reuse") && fs.existsSync(RAW)) {
  ({ changed, strong, mean } = JSON.parse(fs.readFileSync(RAW, "utf8")));
  if (changed.length !== N) throw new Error("the saved measurement is for a different cut; run without --reuse");
} else {
  const { server, port } = await serve(0);
  const browser = await chromium.launch({ channel: "chrome", args: ["--force-color-profile=srgb"] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`http://127.0.0.1:${port}/index.html?bare`);
  await page.waitForFunction("window.ready === true", null, { timeout: 120000 });
  for (let a = 0; a < N; a += 240) {
    const part = await page.evaluate(([a, b]) => {
      const W = 384, H = 216, src = document.getElementById("film");
      const c = (window.__small ??= Object.assign(document.createElement("canvas"), { width: W, height: H }));
      const g = c.getContext("2d", { willReadFrequently: true });
      const grab = (i) => { window.renderAt(i / 60); g.drawImage(src, 0, 0, W, H); return g.getImageData(0, 0, W, H).data; };
      let prev = window.__prev && window.__prevIndex === a - 1 ? window.__prev : a > 0 ? grab(a - 1) : null;
      const out = [];
      for (let i = a; i < b; i++) {
        const cur = grab(i);
        if (prev) {
          let n = 0, big = 0, sum = 0;
          for (let k = 0; k < cur.length; k += 4) {
            const d = Math.max(Math.abs(cur[k] - prev[k]), Math.abs(cur[k + 1] - prev[k + 1]), Math.abs(cur[k + 2] - prev[k + 2]));
            sum += d; if (d > 12) n++; if (d > 48) big++;
          }
          out.push([n, big, sum / (W * H)]);
        }
        prev = cur;
      }
      window.__prev = prev; window.__prevIndex = b - 1;
      return out;
    }, [a, Math.min(N, a + 240)]);
    for (const [n, big, m] of part) { changed.push(n); strong.push(big); mean.push(Number(m.toFixed(4))); }
  }
  await browser.close();
  server.close();
  fs.mkdirSync(path.dirname(RAW), { recursive: true });
  fs.writeFileSync(RAW, JSON.stringify({ changed, strong, mean }));
}

// frame classes
const cls = strong.map((n, i) => (n >= 120 ? 2 : mean[i] > 0 ? 1 : 0));
// voice and pencil, per frame
const speaking = new Uint8Array(N), pencil = new Uint8Array(N);
const parts = LINES.flatMap((l) => l.parts.map((p) => ({ ...tl.parts[p.id], id: p.id })));
for (const p of parts) for (let i = Math.round(p.start * FPS); i < Math.round(p.end * FPS) && i < N; i++) speaking[i] = 1;
const mods = { lever, stall, stamps, apply, scroll, card };
for (const s of tl.scenes) for (const c of mods[s.id].cues(tl, s)) {
  if (c.s !== "scratch" && c.s !== "tick") continue;
  for (let i = Math.round(c.t * FPS); i < Math.round((c.t + (c.d ?? 0.2)) * FPS) && i < N; i++) pencil[i] = 1;
}

// longest stretches with no voice
function longest(test) {
  let best = [0, 0], run = 0;
  for (let i = 0; i <= N; i++) {
    if (i < N && test(i)) run++;
    else { if (run > best[0]) best = [run, i - run]; run = 0; }
  }
  return { seconds: best[0] / FPS, from: best[1] / FPS };
}
// a pause shorter than a third of a second between two actions (the gap between two ticks, say) is not "nothing happening"
const active = new Uint8Array(N);
for (let i = 0; i < N; i++) active[i] = cls[i] === 2 || pencil[i] ? 1 : 0;
const quiet = longest((i) => !speaking[i] && !active[i]);
const dead = longest((i) => !speaking[i] && cls[i] === 0 && !pencil[i]);
const silent = longest((i) => !speaking[i]);
const end = Math.round((tl.duration - 3.2) * FPS);   // the closing card is meant to rest
const quietBody = (() => { let best = [0, 0], run = 0; for (let i = 0; i <= end; i++) { if (i < end && !speaking[i] && !active[i]) run++; else { if (run > best[0]) best = [run, i - run]; run = 0; } } return { seconds: best[0] / FPS, from: best[1] / FPS }; })();

const lines = [];
lines.push(`film ${tl.duration.toFixed(3)} s, ${N} frames; action in ${(100 * cls.filter((c) => c === 2).length / N).toFixed(1)}% of frames, slow change in ${(100 * cls.filter((c) => c === 1).length / N).toFixed(1)}%, no change at all in ${(100 * cls.filter((c) => c === 0).length / N).toFixed(1)}%`);
lines.push(`longest stretch with no voice: ${silent.seconds.toFixed(2)} s, from ${silent.from.toFixed(2)} s`);
lines.push(`longest stretch with no voice and no action (only slow change such as the camera creeping in): ${quiet.seconds.toFixed(2)} s, from ${quiet.from.toFixed(2)} s`);
lines.push(`  the same, leaving out the last 3.2 s (the closing card at rest): ${quietBody.seconds.toFixed(2)} s, from ${quietBody.from.toFixed(2)} s`);
lines.push(`longest stretch with no voice and no change in the picture at all: ${dead.seconds.toFixed(2)} s${dead.seconds ? ", from " + dead.from.toFixed(2) + " s" : ""}`);
lines.push("");
lines.push("all stretches of 0.9 s or more with no voice and no action:");
{ let run = 0; for (let i = 0; i <= N; i++) { if (i < N && !speaking[i] && !active[i]) run++; else { if (run >= 0.9 * FPS) lines.push(`  ${((i - run) / FPS).toFixed(2)} - ${(i / FPS).toFixed(2)} s  (${(run / FPS).toFixed(2)} s)`); run = 0; } } }
lines.push("");
lines.push("second | voice                                    | moving              | drawing");
for (let s = 0; s < Math.ceil(tl.duration); s++) {
  const a = s * FPS, b = Math.min(N, a + FPS);
  const words = [];
  for (const p of parts) {
    const ws = p.text.split(" "); let pos = 0;
    for (const w of ws) { const t = p.start + (pos / p.text.length) * (p.end - p.start); if (t >= s && t < s + 1) words.push(w); pos += w.length + 1; }
  }
  let act = 0, slow = 0, pen = 0;
  for (let i = a; i < b; i++) { if (cls[i] === 2) act++; else if (cls[i] === 1) slow++; if (pencil[i]) pen++; }
  const n = b - a;
  const moving = act >= n * 0.5 ? "action" : act > 0 ? `action ${(act / FPS).toFixed(1)} s, then slow`.replace(", then slow", slow ? " + slow" : "") : slow ? "slow (creep, sway)" : "still";
  lines.push(`${String(s).padStart(4)}   | ${words.join(" ").slice(0, 40).padEnd(40)} | ${moving.padEnd(19)} | ${pen ? `pencil ${(pen / FPS).toFixed(1)} s` : "-"}`);
}
const out = path.join(HERE, "../out/evidence/activity.txt");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log(lines.slice(0, 22).join("\n"));
console.log(`... table written to ${out}`);
