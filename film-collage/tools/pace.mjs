// Checks the pace of scene 6 against its rules, from the timeline alone (no rendering):
//   every pencil mark is drawn at a pace the eye can follow and then stays in full view for 1.8 s;
//   every print is on screen for 4.5 s; every photograph the voice points at is readable for 2.5 s;
//   and no gap in the voice goes more than about 1.2 s without the pencil, a print or the hand moving.
//
//   node tools/pace.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTimeline } from "../src/timeline.js";
import { LINES } from "../src/script.js";
import * as A from "../src/scenes/apply.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tl = buildTimeline(JSON.parse(fs.readFileSync(path.join(HERE, "../assets/audio/clips.json"), "utf8")));
const e = A.events(tl), marks = A.schedule(e);
const sc = Object.fromEntries(tl.scenes.map((s) => [s.id, s]));
const f = (x) => x.toFixed(2).padStart(6);
const next = sc.scroll.start;                         // the following sheet starts in (from the left)
// When print i (or a mark at screenshot x on it) stops being in full view: the next print covers it,
// or, for the last print, the next sheet does. That sheet comes from the left with the film's ease,
// so it reaches a point on the right later than one on the left.
const ease = (p) => p ** 3 / (p ** 3 + (1 - p) ** 3);
function sheetReaches(sx) {
  const desk = 960 - 10 + (-720 + sx * (1440 / 1470)), x = (desk - 960) * 1.2 * 1.022 + 960;   // on screen, in the last framing
  let lo = 0, hi = 1;
  for (let k = 0; k < 40; k++) { const p = (lo + hi) / 2; if (1950 - 2060 * (1 - ease(p)) >= x) hi = p; else lo = p; }
  return next + hi * tl.SLIDE;
}
const covered = (i, sx = 760) => (i + 1 < e.deal.length ? e.deal[i + 1] + A.COVERS : sheetReaches(sx));
let bad = 0;
const flag = (ok) => (ok ? "" : (bad++, "   <-- SHORT"));

console.log(`scene 6: sheet in at ${f(sc.apply.start)} s, next sheet at ${f(next)} s (${(next - sc.apply.start).toFixed(1)} s); film ${tl.duration.toFixed(2)} s\n`);
console.log("print | dealt  | landed | covered | on screen | landed and still");
A.SHOTS.forEach((n, i) => {
  const d = e.deal[i] ?? sc.apply.start, land = e.land[i] ?? sc.apply.start + tl.SLIDE, c = covered(i);
  console.log(`${String(i + 1).padStart(5)} | ${f(d)} | ${f(land)} | ${f(c)}  | ${f(c - d - 0.3)} s  | ${f(c - land)} s${flag(c - d - 0.3 >= 4.495 && c - land >= 2.495)}`);
});
console.log("\nmark                                                              | print | starts | stroke | done   | in view after");
for (const m of marks) {
  const done = m.t + m.d, c = covered(m.print, m.at ? m.at[0] : m.kind === "ring" ? m.box[2] : m.kind === "under" ? m.box[1] : m.box[0]);
  const slow = m.kind === "ring" ? m.d >= 0.6 : m.kind === "tick" ? m.d >= 0.15 : m.d >= 0.4;
  console.log(`${m.name.slice(0, 65).padEnd(65)} | ${String(m.print + 1).padStart(5)} | ${f(m.t)} | ${m.d.toFixed(2)} s | ${f(done)} | ${f(c - done)} s${flag(c - done >= 1.795 && slow && m.t >= (e.land[m.print] ?? 0) - 0.06)}`);
}

// voice gaps, and what happens in them
const voice = LINES.map((l) => tl.lines[l.id]).map((l) => [l.start, l.end]);
const busy = [
  ...marks.map((m) => [m.t, m.t + m.d]),
  ...e.deal.filter((t) => t !== null).map((t) => [t + 0.15, t + A.DEAL]),   // a dealt print is in frame for most of its deal
  [e.push, e.push + 1.1], [e.frame, e.frame + 0.95], [e.apply - 0.75, e.apply + 0.95], [e.roll - 0.7, e.roll + 1.2],
  [sc.apply.start, sc.apply.start + 1.15], [next, next + tl.SLIDE],
].sort((a, b) => a[0] - b[0]);
console.log("\ngaps in the voice during scene 6 (silence | longest stretch in it with no pencil, print, hand or camera move; a slow creep-in continues)");
let worst = 0;
for (let i = 0; i < voice.length - 1; i++) {
  const [a, b] = [voice[i][1], voice[i + 1][0]];
  if (b < sc.apply.start || a > next + 1) continue;
  let t = a, idle = 0;
  for (const [s0, s1] of busy) { if (s1 <= t || s0 >= b) continue; idle = Math.max(idle, Math.min(s0, b) - t); t = Math.max(t, s1); }
  idle = Math.max(idle, b - Math.min(t, b));
  worst = Math.max(worst, idle);
  console.log(`  ${f(a)} - ${f(b)}  ${(b - a).toFixed(2)} s | ${idle.toFixed(2)} s${idle > 1.25 ? "   <-- LONG" : ""}`);
}
console.log(`\nlongest idle stretch inside a voice gap: ${worst.toFixed(2)} s; rule failures: ${bad}`);
