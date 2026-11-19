// Scene 7 (narration line 10). "We tried sixty-two million times to make the rules give a wrong answer. They never did."
// A tally roll that will not stop, paper balls bouncing off the rulebook, and the count from the fuzzer.

import { C, FONT, S, paper, piece, put, ink, label, wob, stroke, P, mk } from "../lib/paper.js";
import { E, prog, spring, swing, lerp, mulberry, TAU } from "../lib/util.js";
import { drawClosedBook } from "../cast.js";
import { camera, track, writeOn } from "./common.js";

const SX = 1262, SW = 640, TILE = 1024;
const BOOKAT = [400, 560];

export function events(tl) {
  const e = { a: tl.p("10a").start, count: tl.word("10a", "sixty-two"), wrong: tl.word("10a", "the rules") + 0.1, never: tl.word("10b", "never") + 0.02, end: tl.p("10b").end };
  // paper balls thrown at the rulebook: [time it hits, where on the book, where it came from]
  const r = mulberry(707);
  e.balls = Array.from({ length: 7 }, (_, i) => ({ hit: e.a - 0.25 + i * 0.62 + r() * 0.12, dx: -120 + r() * 200, dy: -170 + r() * 300, from: [-160 - r() * 80, 120 + r() * 520], spin: (r() - 0.5) * 9 }));
  return e;
}

export function cues(tl, scene) {
  const e = events(tl);
  return [
    { t: scene.start + 0.1, s: "slide", g: 0.7 }, { t: scene.start + 0.5, s: "unroll", g: 0.5, d: 2.4 },
    ...e.balls.map((b) => ({ t: b.hit, s: "tap", g: 0.4 })),
    { t: e.count - 0.35, s: "paper", g: 0.6 }, { t: e.wrong - 0.2, s: "scratch", g: 0.45, d: 0.55 },
    { t: e.never - 0.5, s: "whoosh", g: 0.3 }, { t: e.never, s: "stamp", g: 1 }, { t: e.never + 0.22, s: "ding", g: 0.6 },
  ];
}

export function build(A, tl, scene) {
  const s = { e: events(tl), start: scene.start, book: A.book, T: A.stamps, props: A.props };
  const r = mulberry(700);
  // one length of tally roll; it repeats seamlessly (its height is a whole number of grain tiles)
  const marks = [];
  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 5; col++) {
      const x0 = -SW / 2 + 54 + col * 112 + (r() - 0.5) * 8, y0 = 22 + row * 102.4 + (r() - 0.5) * 6;
      for (let k = 0; k < 4; k++) marks.push(wob(P.line(x0 + k * 17 + (r() - 0.5) * 4, y0, x0 + k * 17 + (r() - 0.5) * 5, y0 + 56 + (r() - 0.5) * 8), { amp: 1.1, seed: 710 + marks.length }));
      marks.push(wob(P.line(x0 - 12, y0 + 46 + (r() - 0.5) * 8, x0 + 64, y0 + 10 + (r() - 0.5) * 8), { amp: 1.1, seed: 710 + marks.length }));
    }
  }
  s.tile = paper([[-SW / 2, 0], [SW / 2, 0], [SW / 2, TILE], [-SW / 2, TILE]], {
    color: C.white, seed: 701, edge: "clean", shadow: false, pad: 0, edgeShade: false,
    draw(g) { for (const m of marks) stroke(g, m, { color: C.coffee, w: 3.6, a: 0.8 }); },
  });
  s.strip = paper(S.rect(SW, 1500), { color: C.white, seed: 702, edge: "clean", res: 1, blur: 9 });
  s.rollEnd = paper(S.rrect(SW + 56, 84, 40), {
    color: C.cream, seed: 703, edge: "cut", blur: 7,
    draw(g) { g.strokeStyle = "rgba(75,52,37,0.3)"; g.lineWidth = 2; for (const y of [-22, -6, 12, 26]) { g.beginPath(); g.moveTo(-SW / 2 - 10, y); g.lineTo(SW / 2 + 10, y + 2); g.stroke(); } },
  });
  s.card = paper(S.rrect(760, 330, 14), { color: C.kraftLight, seed: 704, edge: "torn", amp: 2.6, blur: 8 });
  s.num = label("62,464,769", { size: 138, font: FONT.print, weight: 400, color: C.ink, bold: 2.6 });
  s.tries = label("tries", { size: 84, color: C.coffee });
  s.zero = label("0 violations", { size: 96, font: FONT.print, weight: 400, color: C.sageDark, bold: 2 });
  s.ball = [0, 1, 2].map((i) => {
    const folds = Array.from({ length: 4 }, (_, k) => wob(P.line((r() - 0.5) * 30, (r() - 0.5) * 30, (r() - 0.5) * 40, (r() - 0.5) * 40), { amp: 1.5, seed: 720 + i * 7 + k, step: 4 }));
    return paper(S.blob(25, 23, 730 + i, 0.2, 18), { color: i === 1 ? C.cream : C.white, seed: 730 + i, edge: "cut", blur: 3, amp: 1.5, draw(g) { for (const f of folds) stroke(g, f, { color: C.kraftDark, w: 1.8, a: 0.7 }); } });
  });
  s.table = paper([[-470, 0], [470, 0], [470, 380], [-470, 380]], { color: C.sagePale, edge: "torn", seed: 740, res: 1, amp: 4.5 });
  s.easel = paper([[-150, 0], [150, 0], [120, 70], [-120, 70]], { color: C.kraftDark, seed: 741, edge: "cut" });
  s.star = wob(P.line(0, -1, 0, 1), { amp: 0, seed: 1 });
  return s;
}

// How far the roll has run: fast at first, easing to a steady crawl. Smooth in t, never stops.
const run = (d) => (d <= 0 ? 0 : 150 * d + 1150 * 1.1 * (1 - Math.exp(-d / 1.1)));

export function draw(ctx, t, s) {
  const e = s.e;
  ctx.save();
  camera(ctx, 960, 540 + 6 * prog(t, s.start, e.end + 1.2), 1.005 + 0.02 * E.inOutSine(prog(t, s.start, e.end + 1.4)));

  // the roll
  const off = run(t - s.start - 0.2);
  put(ctx, s.strip, SX, 520, { rot: 0, lift: 1.4 });
  ctx.save();
  ctx.beginPath(); ctx.rect(SX - SW / 2 - 2, -120, SW + 4, 1110); ctx.clip();
  const y0 = -(off % TILE);
  for (let k = -1; k < 2; k++) put(ctx, s.tile, SX, y0 + k * TILE, { sh: 0 });
  ctx.restore();
  put(ctx, s.rollEnd, SX, 1010, { lift: 1.6 });
  globalThis.__probe && (globalThis.__probe["scroll:run"] = [0, -off]);   // unwrapped, for measuring

  // the rulebook on its little stand, unmoved
  put(ctx, s.table, 400, 830, { lift: 0.7 });
  let knock = 0;
  for (const b of e.balls) knock += swing(t - b.hit, 0.012, 3.2, 5);
  put(ctx, s.easel, BOOKAT[0], BOOKAT[1] + 222);
  drawClosedBook(ctx, s.book, BOOKAT[0], BOOKAT[1], { rot: -0.035 + knock, s: 0.86, lift: 1.4 });
  // the tries: paper balls that arrive, bounce off and drop away
  e.balls.forEach((b, i) => {
    const hit = [BOOKAT[0] - 150 + b.dx * 0.35, BOOKAT[1] + b.dy], d = t - b.hit;
    if (d < -0.75 || d > 1.3) return;
    let x, y;
    if (d <= 0) { const u = 1 + d / 0.75; x = lerp(b.from[0], hit[0], u); y = lerp(b.from[1], hit[1], u) - 90 * 4 * u * (1 - u); }
    else { x = hit[0] - 250 * d; y = hit[1] - 150 * d + 900 * d * d; }
    put(ctx, s.ball[i % 3], x, y, { rot: b.spin * (t - b.hit), s: 1.7, a: 1 - prog(d, 0.8, 1.25), lift: 1.6 });
    if (i === 2) track(ctx, "scroll:ball", x, y);
  });

  // the count
  const cin = spring(t - (e.count - 0.4), 1.7, 0.62);
  const cx = SX - 6 + 900 * (1 - cin), cy = 432;
  put(ctx, s.card, cx, cy, { rot: -0.018 + 0.06 * (1 - Math.min(1, cin)), lift: 2 });
  put(ctx, s.props.tapeC, cx - 330, cy - 152, { rot: -0.6, lift: 0.5 });
  put(ctx, s.props.tapeC, cx + 334, cy - 150, { rot: 0.55, lift: 0.5 });
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.018 + 0.06 * (1 - Math.min(1, cin)));
  put(ctx, s.num, -64, -62);
  put(ctx, s.tries, 300, -52, { rot: -0.03 });
  writeOn(ctx, s.zero, -40, 76, E.inOut(prog(t, e.wrong - 0.2, e.wrong + 0.4)));
  // "They never did.": the green stamp comes down beside it
  if (t >= e.never) put(ctx, s.T.markOk, 268, 78, { rot: -0.18, s: 0.74 });
  ctx.restore();
  const m = E.inOut(prog(t, e.never - 0.6, e.never - 0.16)) - E.inOut(prog(t, e.never + 0.16, e.never + 0.9));
  const press = E.in(prog(t, e.never - 0.15, e.never)) - E.out(prog(t, e.never + 0.1, e.never + 0.34));
  if (m > 0) {
    const px = lerp(2060, cx + 268, m), py = lerp(760, cy + 78 + 66, m) - 60 * Math.sin(Math.PI * Math.min(1, m));
    put(ctx, s.T.ok, px, py, { rot: 0.25 * (1 - m) + 0.1 * press, s: 1.05 + 0.4 * m - 0.24 * press, lift: 1 + 9 * m - 8.6 * press });
    track(ctx, "scroll:stamp", px, py);
  }
  ctx.restore();
}
