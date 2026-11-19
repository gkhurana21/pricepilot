// Scene 1. "Change a price by one percent, and profit moves by eleven. In either direction."
// A long arm hinged at one end. A hand nudges a tag marked 1% that sits one notch from the hinge;
// the cut-out 11% rides eleven notches out, so it travels eleven times as far. Up, then down.

import { C, FONT, S, paper, put, ink, label, cutout, wob, stroke, P } from "../lib/paper.js";
import { E, prog, spring, tween, TAU } from "../lib/util.js";
import { makeTag } from "../cast.js";
import { camera, track, writeOn } from "./common.js";

const PIVOT = [292, 648], UNIT = 109, SWING = 0.148; // 8.5 degrees
export const PRINT = "Harvard Business Review, 1992  ·  average of 2,463 companies  ·  volume held constant";

export function events(tl) {
  const one = tl.word("01a", "one percent"), profit = tl.word("01a", "profit"), eleven = tl.word("01a", "eleven"), either = tl.p("01b").start;
  return { one, profit, eleven, either, end: tl.p("01b").end };
}

export function cues(tl) {
  const e = events(tl);
  return [
    { t: 0.25, s: "slide", g: 0.5 }, { t: 0.62, s: "knock", g: 0.5 }, { t: 1.25, s: "slide", g: 0.35 },
    { t: e.one - 0.05, s: "tap", g: 0.7 }, { t: e.profit - 0.2, s: "creak", g: 0.6 },
    { t: e.eleven - 0.08, s: "pop", g: 0.8 }, { t: e.either, s: "creak", g: 0.7 }, { t: e.either + 0.45, s: "knock", g: 0.35 },
  ];
}

export function build(A, tl) {
  const L = { e: events(tl), hand: A.hand, tapeB: A.props.tapeB };
  L.table = paper([[-1150, 0], [1150, 0], [1150, 320], [-1150, 320]], { color: C.kraftLight, edge: "torn", seed: 201, res: 1, amp: 4.5 });
  L.disc = paper(S.blob(330, 330, 202, 0.04, 64), { color: C.mustardPale, edge: "torn", seed: 202, res: 1, amp: 3.5 });
  L.hill = paper(S.blob(280, 190, 203, 0.08, 56), { color: C.sagePale, edge: "torn", seed: 203, res: 1, amp: 3.5 });
  L.stand = paper([[0, -26], [118, 208], [-118, 208]], { color: C.kraft, edge: "torn", seed: 204, amp: 2.2 });
  L.pin = paper(S.ellipse(19, 19, 30), { color: C.mustard, seed: 205, blur: 2 });
  L.arm = paper(S.move(S.rrect(1560, 34, 8), 680, 0), {
    color: C.coffee, seed: 206,
    draw(g) {
      g.fillStyle = C.cream;
      for (let i = 1; i <= 12; i++) g.fillRect(i * UNIT - 2, i === 1 || i === 11 ? -15 : -7, 4, i === 1 || i === 11 ? 30 : 14);
    },
  });
  L.level = wob(P.line(PIVOT[0] + 40, PIVOT[1], 1800, PIVOT[1]), { amp: 1.4, seed: 207, step: 8 });
  L.tag = makeTag({ w: 118, h: 132, price: "1%", priceColor: C.tomato, priceSize: 62, seed: 208 });
  L.big = cutout("11%", { size: 310, color: C.tomato, seed: 209, jitter: 1.1 });
  L.arrow = paper([[0, -78], [58, -6], [22, -6], [22, 78], [-22, 78], [-22, -6], [-58, -6]], { color: C.coffee, seed: 210 });
  L.price = label("price", { size: 84, color: C.coffee, pencil: 0.22 });
  L.profit = label("profit", { size: 84, color: C.coffee, pencil: 0.22 });
  L.toPrice = wob(P.bez([508, 566], [478, 560], [452, 572], [436, 596], 14), { amp: 1.2, seed: 12 });
  L.print = paper(S.rect(1210, 62), {
    color: C.white, edge: "deckle", seed: 211,
    draw(g) { ink(g, PRINT, 0, 11, { size: 33, font: FONT.print, weight: 400, color: C.coffee }); },
  });
  return L;
}

export function draw(ctx, t, L) {
  const e = L.e;
  ctx.save();
  camera(ctx, 960 + 8 * prog(t, 0, 8), 540, 1.012 + 0.02 * E.inOutSine(prog(t, 0, 8.5)));

  // how far the arm is tipped: up when the hand lifts the 1% tag, down for "in either direction"
  const th = -SWING * spring(t - (e.profit - 0.3), 1.5, 0.5) + 2 * SWING * spring(t - (e.either - 0.05), 1.25, 0.46)
    - SWING * E.inOut(prog(t, e.end + 0.15, e.end + 1.3));
  const at = (r, up = 0) => [PIVOT[0] + Math.cos(th) * r + Math.sin(th) * up, PIVOT[1] + Math.sin(th) * r - Math.cos(th) * up];

  put(ctx, L.disc, 1480, 500, { rot: 0.02 * t, lift: 0.7, sh: 0.7 });
  put(ctx, L.hill, 250, 900, { rot: -0.1, lift: 0.7, sh: 0.7 });
  put(ctx, L.table, 960, 876, { lift: 0.8 });

  // a pencilled level line, so the eye can see how far each end leaves it
  stroke(ctx, L.level, { color: C.coffee, w: 2.6, a: 0.5, dash: [3, 15], to: E.inOut(prog(t, 0.7, 1.5)) });

  // stand, arm, pin
  const stIn = spring(t - 0.12, 1.9, 0.55);
  put(ctx, L.stand, PIVOT[0], PIVOT[1] + 520 * (1 - stIn), { rot: -0.015 });
  const aIn = E.outQuint(prog(t, 0.3, 1.25));
  ctx.save();
  ctx.translate(-1700 * (1 - aIn), 0);
  put(ctx, L.arm, PIVOT[0], PIVOT[1], { rot: th + 0.05 * (1 - spring(t - 0.3, 1.2, 0.5)), lift: 1.2 });
  ctx.restore();
  put(ctx, L.pin, PIVOT[0], PIVOT[1], { a: prog(t, 0.2, 0.4) > 0 ? 1 : 0, s: spring(t - 0.3, 3, 0.5), lift: 0.7 });
  track(ctx, "lever:tip", ...at(11 * UNIT));

  // "profit": label that rides the far end
  const pf = at(11 * UNIT, -64);
  writeOn(ctx, L.profit, pf[0], pf[1], E.inOut(prog(t, 1.25, 1.85)), { rot: th * 0.6 });

  // the 1% tag, carried in by the hand and set on the first notch
  const p1 = at(UNIT, 13);
  const carry = 1 - E.outQuint(prog(t, e.one - 0.95, e.one));
  const bounce = 1 - spring(t - (e.one - 0.95), 1.1, 0.75);
  const hx = p1[0] - 380 * carry, hy = p1[1] - 112 - 800 * carry - 10 * bounce * (1 - carry);
  put(ctx, L.tag, hx, hy, { rot: th * 0.5 - 0.3 * carry, lift: 1 + 4 * carry });
  put(ctx, L.hand, hx - 5, hy - 2, { rot: -0.5 - 0.18 * carry + th * 0.3, lift: 2.5 });
  track(ctx, "lever:tag", hx, hy);

  // "price", written beside it with a little pointer
  const wP = E.inOut(prog(t, e.one + 0.1, e.one + 0.6));
  writeOn(ctx, L.price, 596, 548, wP, { rot: -0.03 });
  stroke(ctx, L.toPrice, { color: C.coffee, w: 3.2, to: E.inOut(prog(t, e.one + 0.5, e.one + 0.85)) });

  // the 11%: cut-out numerals that land on the far end as the word is said, and ride it
  const pop = spring(t - (e.eleven - 0.12), 2.6, 0.5);
  if (pop > 0) {
    const p11 = at(11 * UNIT, 13);
    const sway = 0.03 * Math.sin(t * 1.7) * Math.min(1, pop);
    put(ctx, L.big, p11[0] - 30, p11[1] - 102, { rot: th * 0.7 + sway, s: pop, lift: 2 });
    // which way it went
    const aPop = spring(t - (e.eleven + 0.12), 2.6, 0.55);
    const turn = Math.PI * spring(t - (e.either + 0.1), 1.5, 0.62);
    put(ctx, L.arrow, p11[0] - 332, p11[1] - 130, { rot: turn + th * 0.4, s: aPop * 0.92, lift: 1.4 });
  }

  // the source, in small print, for as long as the scene lasts
  const prIn = spring(t - 1.0, 1.5, 0.7);
  const py = 992 + 150 * (1 - prIn);
  put(ctx, L.print, 960, py, { rot: -0.004 });
  put(ctx, L.tapeB, 356, py - 2, { rot: -1.45, lift: 0.5 });
  put(ctx, L.tapeB, 1564, py + 1, { rot: 1.52, lift: 0.5 });
  ctx.restore();
}
