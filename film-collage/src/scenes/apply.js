// Scene 6 (narration lines 06 to 09). The real app.
// Six photographs of the app's own screen in the Shopify admin, printed large on white photo paper
// and dealt onto the desk one on top of another. They are the only things in the film that are not
// drawings, and they are not retouched: each screenshot is drawn whole, scaled, and nothing else.
// Everything added is pencil beside the app's words, never on them: a ring round a badge, a line
// under a phrase, a brace or a tick in the margin. Her hand presses two paper buttons.
//
// The pace is set by the pencil, not by a length: every mark is drawn slowly enough to follow, and
// then stays in full view (see `schedule()` and tools/pace.mjs, which checks it). The voice is laid
// out in phrases around that: it names a thing, the print lands, the pencil marks it.
//
//   06   "Here is the real app, inside Shopify. The order history here is synthetic, and the app says so."
//   07a  "Refusals come first, with the reasons listed."
//   07b  "Then the four prices a rule pulled back,"
//   07c  "and the one that passed every rule."
//   08   "Apply, and each price is read back from Shopify."
//   09a  "Change your mind,"
//   09b  "and everything goes back."

import { C, S, paper, put, ink, label, wob, stroke, P } from "../lib/paper.js";
import { E, prog, spring, lerp, bump } from "../lib/util.js";
import { camera, track, writeOn } from "./common.js";

// The screenshots are 1470 x 668. Printed 1440 wide: a shade under 1:1, so with the camera in at 1.27
// the app's text is 1.24 times its size on the original screen.
const SRC = [1470, 668], PW = 1440, PS = PW / SRC[0], PH = SRC[1] * PS;
const BORDER = { side: 16, top: 16, bottom: 54 };
const SHEET = [PW + 2 * BORDER.side, PH + BORDER.top + BORDER.bottom];
const AT = [960, 494];                                  // centre of the pile on the desk
const IMG0 = [-PW / 2, -SHEET[1] / 2 + BORDER.top];     // image's top-left corner, from the sheet's centre
export const SHOTS = [1, 2, 3, 4, 5, 6];                // every screenshot, in the app's own order
// Each print lies a little differently on the pile: [dx, dy, rotation]. Each goes down slightly lower
// and further left than the one before, so it covers that one's handwritten label completely.
const LIE = [[10, -17, -0.006], [6, -10, 0.006], [2, -3, -0.005], [-2, 4, 0.006], [-6, 11, -0.005], [-10, 18, 0.006]];
const BTN = { apply: [1262, 926], back: [1540, 926] };
const VIEW = { wide: [960, 472, 1.0], read: [960, 494, 1.27], act: [960, 584, 1.2] };
export const DEAL = 0.85;                               // seconds a print takes to be dealt
export const COVERS = 0.5;                              // ...and how far into that it hides what is under it

// A point on the screenshot (its own pixel coordinates) as a point on the print.
const at = (sx, sy) => [IMG0[0] + sx * PS, IMG0[1] + sy * PS];

export function events(tl) {
  const p = tl.p, w = tl.word;
  const e = {
    a: p("06a").start, inside: w("06a", "inside"), b: p("06b").start, synth: w("06b", "synthetic"),
    refuse: p("07a").start, reasons: w("07a", "reasons"),
    four: p("07b").start, fourEnd: p("07b").end, count: w("07b", "four prices"),
    one: p("07c").start,
    line8: p("08a").start, read: w("08a", "read back"),
    mind: p("09a").start, back: p("09b").start, end: p("09b").end,
  };
  e.push = e.b - 0.3;                         // camera goes in to reading distance
  e.apply = e.line8 + 0.14;                   // the press on "Apply"
  e.roll = e.mind + 0.55;                     // the press on "Change your mind"
  // When each print is dealt (the first is already on the sheet when it slides in). The voice names a
  // thing, then its print lands; a press on a paper button brings the app's answer.
  e.deal = [null, e.fourEnd + 0.15, e.one + 0.8, e.apply + 0.16, e.roll + 0.16, e.back + 0.75];
  e.land = e.deal.map((t) => (t === null ? null : t + DEAL));
  e.frame = e.land[2] + 2.05;                 // camera eases back to take in the buttons
  return e;
}

// Every pencil mark: which print, what, when it starts and how long the stroke takes.
// Coordinates are the screenshot's own pixels; each mark sits in a blank gap or margin.
export function schedule(e) {
  const L = e.land;
  const ticks = (print, name, ys, x, t0, step, d) => ys.map((y, i) => ({ print, name: `${name} ${i + 1}`, kind: "tick", at: [x, y], t: t0 + i * step, d, sound: "tick" }));
  return [
    // 1: the preview. (The first mark is on the print's white border, beside the Shopify admin's sidebar.)
    { print: 0, name: "bracket on the border: the Shopify admin", kind: "brace", box: [-11, 22, 646], t: e.inside - 0.1, d: 0.7 },
    { print: 0, name: "ring: Synthetic order history notice", kind: "ring", box: [349, 112, 1337, 218], t: e.synth - 0.1, d: 0.8 },
    { print: 0, name: "line under: Held back heading", kind: "under", box: [360, 672, 346], t: e.refuse + 0.1, d: 0.45 },
    { print: 0, name: "ring: Change too small", kind: "ring", box: [1189, 404, 1319, 440], t: e.reasons - 0.1, d: 0.65 },
    { print: 0, name: "brace: the six reasons", kind: "brace", box: [342, 470, 634], t: e.reasons + 0.65, d: 0.5 },
    { print: 0, name: "line under: 4 adjusted by a guardrail", kind: "under", box: [598, 748, 251], t: e.count - 0.25, d: 0.55 },
    // 2: adjusted by a guardrail
    { print: 1, name: "line under: Adjusted by a guardrail", kind: "under", box: [360, 524, 414], t: L[1] - 0.05, d: 0.45 },
    { print: 1, name: "ring: Largest decrease per run", kind: "ring", box: [1147, 473, 1319, 509], t: L[1] + 0.55, d: 0.7 },
    { print: 1, name: "line under: model proposed $14.99", kind: "under", box: [740, 888, 533], t: L[1] + 1.4, d: 0.45 },
    // 3: accepted
    { print: 2, name: "line under: Accepted", kind: "under", box: [360, 429, 582], t: L[2] - 0.05, d: 0.4 },
    { print: 2, name: "brace: Every guardrail passed", kind: "brace", box: [342, 606, 664], t: L[2] + 0.5, d: 0.5 },
    { print: 2, name: "ring: Rounded to .99", kind: "ring", box: [1203, 642, 1319, 677], t: L[2] + 1.15, d: 0.65 },
    // 4: the apply report
    { print: 3, name: "line under: 5 of 5 verified by re-reading prices from Shopify", kind: "under", box: [558, 849, 357], t: Math.max(e.read - 0.05, L[3]), d: 0.5 },
    ...ticks(3, "tick beside verified", [449, 527, 604], 676, Math.max(e.read - 0.05, L[3]) + 0.65, 0.38, 0.2),
    // 5: the app asks before it rolls back
    { print: 4, name: "line under: This restores every price the run changed to its previous value.", kind: "under", box: [376, 754, 330], t: L[4], d: 0.6 },
    { print: 4, name: "ring: Yes, roll back", kind: "ring", box: [367, 340, 484, 377], t: L[4] + 0.9, d: 0.65 },
    // 6: the rollback report
    { print: 5, name: "line under: 5 restored, 0 skipped, 0 failed", kind: "under", box: [376, 556, 110], t: L[5], d: 0.45 },
    ...ticks(5, "tick beside Restored", [174, 251, 329, 406, 484], 1350, L[5] + 0.6, 0.32, 0.18),
    { print: 5, name: "brace: all five restored", kind: "brace", box: [1396, 164, 494, -1], t: L[5] + 2.2, d: 0.5 },
  ];
}

export function cues(tl, scene) {
  const e = events(tl);
  const deal = (t) => [{ t: t + 0.12, s: "slide", g: 0.75, d: 0.5 }, { t: t + DEAL - 0.22, s: "paper", g: 0.75 }];
  return [
    { t: scene.start + 0.1, s: "slide", g: 0.7 }, { t: scene.start + 0.74, s: "tape", g: 0.5 }, { t: scene.start + 0.88, s: "tape", g: 0.45 },
    ...schedule(e).map((m) => (m.kind === "tick" ? { t: m.t + 0.02, s: "tick", g: 0.62 } : { t: m.t, s: "scratch", g: 0.5, d: m.d })),
    ...e.deal.filter((t) => t !== null).flatMap(deal),
    { t: e.frame + 0.15, s: "slide", g: 0.45, d: 0.5 },
    { t: e.apply, s: "click", g: 0.85 }, { t: e.roll, s: "click", g: 0.85 },
  ];
}

// ----- pencil marks, given in screenshot pixels -----
const line = (pts, seed, amp = 1.1) => wob(pts.map(([x, y]) => at(x, y)), { amp, seed, step: 5, wave: 60 });
// a ring drawn round a box by hand: starts on the left side, goes over the top and overshoots its start
function ring([x0, y0, x1, y1], seed) {
  const r = Math.min(14, (y1 - y0) / 2), pts = [], cx = [x0 + r, x1 - r], cy = [y0 + r, y1 - r];
  const arc = (ax, ay, a0, n = 5) => { for (let i = 0; i <= n; i++) { const a = a0 + (i / n) * (Math.PI / 2); pts.push([ax + Math.cos(a) * r, ay + Math.sin(a) * r]); } };
  pts.push([x0, (y0 + y1) / 2 + 4]);
  arc(cx[0], cy[0], Math.PI); arc(cx[1], cy[0], -Math.PI / 2); arc(cx[1], cy[1], 0); arc(cx[0], cy[1], Math.PI / 2);
  pts.push([x0 + 1.5, (y0 + y1) / 2 - 6]);
  return line(pts, seed, 1.0);
}
const under = ([x0, x1, y], seed) => line([[x0, y + 1], [(x0 + x1) / 2, y - 0.5], [x1, y + 0.5]], seed, 0.9);
const brace = ([x, y0, y1, open = 1], seed) => line([[x + 9 * open, y0], [x, y0 + 5], [x, y1 - 5], [x + 9 * open, y1]], seed, 0.9);   // open: 1 faces right, -1 left
const tick = ([x, y], seed) => line([[x - 7, y], [x - 1, y + 7], [x + 11, y - 9]], seed, 0.7);

export function build(A, tl, scene) {
  const s = { e: events(tl), start: scene.start, end: scene.end, hand: A.hand, props: A.props, shots: SHOTS.map((n) => A.shots[n - 1]) };
  s.sheet = paper(S.rrect(SHEET[0], SHEET[1], 6), { color: C.white, seed: 601, edge: "cut", grain: 0.6, blur: 9 });
  s.caption = label("the real app", { size: 50, color: C.coffee, pencil: 0.2, align: "left" });
  s.marks = schedule(s.e).map((m, i) => ({
    ...m,
    path: m.kind === "ring" ? ring(m.box, 610 + i) : m.kind === "under" ? under(m.box, 610 + i) : m.kind === "brace" ? brace(m.box, 610 + i) : tick(m.at, 610 + i),
  }));
  const button = (text, color, seed) => paper(S.rrect(250, 92, 26), {
    color, seed, edge: "cut", blur: 6,
    draw(g) { ink(g, text, 0, 21, { size: 66, color: C.cream }); g.strokeStyle = "rgba(244,236,217,0.5)"; g.lineWidth = 2.5; g.setLineDash([9, 8]); g.strokeRect(-110, -33, 220, 66); },
  });
  s.bApply = button("apply", C.sageDark, 661);
  s.bBack = button("roll back", C.tomato, 662);
  s.board = paper(S.rrect(590, 122, 20), { color: C.kraftLight, seed: 663, edge: "torn", amp: 2.2 });
  return s;
}

export function draw(ctx, t, s) {
  const e = s.e;
  // Camera: the whole print and its label; in to read; then back a little to take in the buttons.
  // While a print is being read the camera keeps creeping in on it, and lets go as the next is dealt.
  const kR = E.inOut(prog(t, e.push, e.push + 1.1)), kA = E.inOut(prog(t, e.frame, e.frame + 0.9));
  // (the opening view is never quite still either: it eases in by two percent while the voice introduces the app)
  const wide = [VIEW.wide[0], VIEW.wide[1], VIEW.wide[2] + 0.022 * E.inOutSine(prog(t, s.start + 0.6, e.push + 0.4))];
  const mix = (i) => lerp(lerp(wide[i], VIEW.read[i], kR), VIEW.act[i], kA);
  let creep = 0;
  e.land.forEach((L, i) => {
    const from = L ?? e.push + 1.1, next = e.deal[i + 1] ?? s.end;
    creep += E.inOutSine(prog(t, from, next)) - E.inOut(prog(t, next, next + DEAL));
  });
  // And once the last mark is down, a slow move in on the five ticks, until the next sheet arrives.
  const last = E.inOut(prog(t, e.land[5] + 2.85, e.land[5] + 4.35));
  ctx.save();
  camera(ctx, mix(0) + 50 * last, mix(1) - 20 * last, mix(2) * (1 + 0.022 * creep + 0.045 * last));

  // the pile of prints
  SHOTS.forEach((n, i) => {
    const T = e.deal[i];
    if (T !== null && t < T) return;
    const k = T === null ? 1 : E.inOut(prog(t, T, T + DEAL));
    const [dx, dy, r] = LIE[i];
    // The first prints are dealt from the bottom right. Once the buttons are on the desk down there,
    // prints come in from the top left instead, so that none has to pass underneath them.
    const from = i >= 3 ? [-1000, -1350, -0.2] : [1080, 1280, 0.2];
    const x = AT[0] + dx + from[0] * (1 - k), y = AT[1] + dy + from[1] * (1 - k);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(r + from[2] * (1 - k));
    put(ctx, s.sheet, 0, 0, { lift: 1.3 + 8 * (1 - k) });
    // the screenshot itself, whole and untouched
    ctx.drawImage(s.shots[i], IMG0[0], IMG0[1], PW, PH);
    ctx.strokeStyle = "rgba(44,32,25,0.28)"; ctx.lineWidth = 1.2;
    ctx.strokeRect(IMG0[0] - 0.6, IMG0[1] - 0.6, PW + 1.2, PH + 1.2);
    writeOn(ctx, s.caption, IMG0[0] + 14, IMG0[1] + PH + 27, i === 0 ? E.inOut(prog(t, s.start + 0.5, s.start + 1.15)) : 1, { rot: -0.012 });
    for (const m of s.marks) if (m.print === i) stroke(ctx, m.path, { color: C.tomato, w: 3.6, to: E.inOutSine(prog(t, m.t, m.t + m.d)) });
    ctx.restore();
    if (i === 1) track(ctx, "apply:print", x, y);
    // tape on the first print only; the rest are simply dealt on top of it
    if (i === 0) {
      for (const [j, [tx, ty, tr]] of [[-SHEET[0] / 2 + 26, -SHEET[1] / 2 - 2, -0.6], [SHEET[0] / 2 - 26, -SHEET[1] / 2 - 4, 0.55]].entries()) {
        const t0 = s.start + 0.72 + j * 0.14, on = prog(t, t0, t0 + 0.04);
        put(ctx, s.props.tapeC, AT[0] + dx + tx, AT[1] + dy + ty, { rot: tr, a: on, s: 1 + 0.6 * (1 - E.out(prog(t, t0, t0 + 0.22))), lift: 0.5 + 4 * (1 - E.out(prog(t, t0, t0 + 0.22))) });
      }
    }
  });

  // the two buttons come up onto the desk when they are needed, and the hand that presses them
  const up = E.inOut(prog(t, e.frame + 0.1, e.frame + 0.95));
  if (up > 0) {
    const by = 420 * (1 - up);
    const pA = bump(t, e.apply - 0.1, e.apply + 0.3), pB = bump(t, e.roll - 0.1, e.roll + 0.3);
    put(ctx, s.board, 1401, 926 + by, { rot: 0.008, lift: 0.9 });
    put(ctx, s.bApply, BTN.apply[0], BTN.apply[1] + by, { rot: -0.015, s: 1 - 0.06 * pA, lift: 1.6 - 1.4 * pA });
    put(ctx, s.bBack, BTN.back[0], BTN.back[1] + by, { rot: 0.012, s: 1 - 0.06 * pB, lift: 1.6 - 1.4 * pB });
    const away = [1980, 1560], near = [1700, 1130];
    const k1 = E.inOut(prog(t, e.apply - 0.75, e.apply - 0.02)), k2 = E.inOut(prog(t, e.apply + 0.2, e.apply + 0.95));
    const k3 = E.inOut(prog(t, e.roll - 0.7, e.roll - 0.02)), k4 = E.inOut(prog(t, e.roll + 0.2, e.roll + 1.2));
    const A1 = [BTN.apply[0] + 34, BTN.apply[1] + 14], B1 = [BTN.back[0] + 34, BTN.back[1] + 14];
    let hx = lerp(away[0], A1[0], k1), hy = lerp(away[1], A1[1], k1);
    hx = lerp(hx, near[0], k2); hy = lerp(hy, near[1], k2);
    hx = lerp(hx, B1[0], k3); hy = lerp(hy, B1[1], k3);
    hx = lerp(hx, away[0], k4); hy = lerp(hy, away[1], k4);
    put(ctx, s.hand, hx, hy, { rot: 2.62 - 0.08 * (pA + pB), lift: 3 - 2 * (pA + pB) });
    track(ctx, "apply:hand", hx, hy);
  }
  ctx.restore();
}
