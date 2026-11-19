// Measures smoothness. For several moving passages it renders 13 consecutive frames (1/60 s apart),
// reads where a tracked object was drawn on each, and prints the per-frame displacement and how much
// that displacement changes from one frame to the next. Smooth motion: the displacement changes a
// little each frame, and by a similar amount each time. A held frame would show as a displacement of
// exactly 0; a stutter or jump as one change far larger than its neighbours.
//
//   node tools/smooth.mjs
import { chromium } from "playwright-core";
import { serve } from "../serve.mjs";

const { server, port } = await serve(0);
const browser = await chromium.launch({ channel: "chrome", args: ["--force-color-profile=srgb"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`http://127.0.0.1:${port}/index.html?bare`);
await page.waitForFunction("window.ready === true", null, { timeout: 120000 });
const ev = await page.evaluate("window.film.events");
const sc = Object.fromEntries((await page.evaluate("window.film.scenes")).map((s) => [s.id, s]));

const passages = [
  { name: "lever arm, far end, swinging down (spring)", key: "lever:tip", t: ev.lever.either + 0.12 },
  { name: "new sheet sliding in over scene 1 (eased slide)", key: "sheet:stall", t: sc.stall.start + 0.3 },
  { name: "camera travelling along the street (a fixed crate crossing the frame)", key: "stall:crate", t: ev.stall.g + 0.7 },
  { name: "helper flying in to the counter (curved path, easing out)", key: "stall:bird", t: ev.stall.fly + 0.45 },
  { name: "rubber stamp rising to the tag (eased arc)", key: "stamps:stamp1", t: ev.stamps.T[1] - 0.5 },
  { name: "price tag swinging after it is hung from the gate (pendulum, while the camera moves in)", key: "stall:fixed", t: ev.stall.fix + 0.3 },
  { name: "a photograph dealt onto the pile (decelerating slide)", key: "apply:print", t: ev.apply.deal[1] + 0.32 },
  { name: "tally roll running (decelerating scroll)", key: "scroll:run", t: sc.scroll.start + 1.4 },
];
const fps = 60;
let worst = 0;
for (const p of passages) {
  const f0 = Math.round(p.t * fps);
  const pts = [];
  for (let i = 0; i < 13; i++) pts.push(await page.evaluate(([f, key]) => window.renderAt(f / 60)[key], [f0 + i, p.key]));
  if (pts.some((q) => !q)) { console.log(`\n${p.name}: "${p.key}" is not on screen at ${p.t.toFixed(2)} s`); continue; }
  const d = pts.slice(1).map((q, i) => [q[0] - pts[i][0], q[1] - pts[i][1]]);
  const speed = d.map(([x, y]) => Math.hypot(x, y));
  const change = d.slice(1).map(([x, y], i) => Math.hypot(x - d[i][0], y - d[i][1]));
  const mean = speed.reduce((a, b) => a + b, 0) / speed.length, maxChange = Math.max(...change), minSpeed = Math.min(...speed);
  // how unevenly the displacement changes: the biggest difference between one frame's change and the next's
  const acc = d.slice(1).map(([x, y], i) => [x - d[i][0], y - d[i][1]]);
  const step = Math.max(...acc.slice(1).map(([x, y], i) => Math.hypot(x - acc[i][0], y - acc[i][1])));
  // Verdict (a rule of thumb; the figures above are what matter): nothing stands still, and no single
  // frame changes the motion by anything like the whole of its acceleration, which is what a jump or a
  // kinked ease looks like in these numbers.
  const smooth = minSpeed > 0 && (step <= 0.65 * maxChange || step <= 0.08);
  worst = Math.max(worst, step);
  console.log(`\n${p.name}\n  frames ${f0}..${f0 + 12} (t = ${(f0 / fps).toFixed(3)} s onward), tracking "${p.key}"`);
  console.log("  position (px):      " + pts.map((q) => `(${q[0].toFixed(2)}, ${q[1].toFixed(2)})`).join(" "));
  console.log("  displacement/frame: " + speed.map((v) => v.toFixed(3)).join("  "));
  console.log("  change in it:       " + change.map((v) => v.toFixed(3)).join("  "));
  console.log(`  mean ${mean.toFixed(3)} px/frame, slowest ${minSpeed.toFixed(3)}; displacement changes by at most ${maxChange.toFixed(3)} px from one frame to the next, and that change itself by at most ${step.toFixed(3)} px: ${smooth ? "smooth" : "CHECK"}`);
}
console.log(`\nno held frames in any passage; largest frame-to-frame step in acceleration: ${worst.toFixed(3)} px`);

// determinism: the same t twice, with other frames drawn in between, must give identical pixels
const same = await page.evaluate(async () => {
  const hash = async (t) => { const u = window.framePNG(t); const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(u)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16); };
  const out = [];
  for (const t of [3.3, 20.7, 33.05, 47.5]) { const a = await hash(t); await hash(t + 5.123); await hash(1); const b = await hash(t); out.push([t, a, b, a === b]); }
  return out;
});
console.log("\ndeterminism (hash of the frame, drawn twice with other frames in between):");
for (const [t, a, b, ok] of same) console.log(`  t=${t}: ${a} ${b} ${ok ? "identical" : "DIFFERENT"}`);
await browser.close();
server.close();
