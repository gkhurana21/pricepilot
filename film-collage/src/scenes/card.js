// Scene 8 (narration line 11). "The agent suggests. The rules decide."  The closing card.

import { C, FONT, S, paper, put, ink, label, wob, stroke, P } from "../lib/paper.js";
import { E, prog, spring, swing, settle, lerp, bump } from "../lib/util.js";
import { makeTag, hangTag, drawBird, drawClosedBook } from "../cast.js";
import { camera, track, writeOn } from "./common.js";

export const URL_TEXT = "github.com/gkhurana21/pricepilot";

export function events(tl) {
  const a = tl.p("11a").start, b = tl.p("11b").start, end = tl.p("11b").end;
  return { a, b, end, name: end + 0.15, url: end + 0.35 };
}

export function cues(tl, scene) {
  const e = events(tl);
  return [
    { t: scene.start + 0.1, s: "slide", g: 0.7 }, { t: e.a - 0.02, s: "tap", g: 0.5 }, { t: e.a + 0.12, s: "chirp", g: 0.55 },
    { t: e.b + 0.02, s: "thump", g: 0.85 }, { t: e.b + 0.4, s: "tap", g: 0.4 }, { t: e.b + 0.52, s: "tap", g: 0.4 }, { t: e.b + 0.64, s: "tap", g: 0.4 },
    { t: e.name, s: "paper", g: 0.6 }, { t: e.name + 0.2, s: "ding", g: 0.5 }, { t: e.url, s: "slide", g: 0.4 },
  ];
}

export function build(A, tl, scene) {
  const s = { e: events(tl), start: scene.start, bird: A.bird, book: A.book, T: A.stamps, props: A.props };
  s.l1 = label("The agent suggests.", { size: 128, color: C.ink });
  s.l2 = label("The rules decide.", { size: 128, color: C.ink });
  s.under = wob(P.bez([-170, 0], [-60, 10], [60, -8], [170, 2], 20), { amp: 1.8, seed: 801, step: 5 });
  const squig = [0, 1].map((i) => wob(P.line(-40, i * 30, 40 - i * 22, i * 30), { amp: 2.4, seed: 802 + i, wave: 14 }));
  s.idea = paper(S.tag(130, 150), {
    color: C.mustardPale, seed: 804, edge: "cut", holes: [{ x: 0, y: 0, r: 6.5 }],
    draw(g) { g.strokeStyle = C.kraft; g.lineWidth = 5.5; g.beginPath(); g.arc(0, 0, 12.5, 0, 7); g.stroke(); g.save(); g.translate(0, 62); for (const q of squig) stroke(g, q, { color: C.coffee, w: 3.4, a: 0.8 }); g.restore(); },
  });
  s.plate = paper(S.rrect(640, 176, 20), {
    color: C.coffee, seed: 805, edge: "cut", blur: 8,
    draw(g) { ink(g, "PricePilot", 0, 42, { size: 138, color: C.cream }); },
  });
  s.url = paper(S.rect(760, 74), {
    color: C.white, seed: 806, edge: "deckle",
    draw(g) { ink(g, URL_TEXT, 0, 14, { size: 44, font: FONT.print, weight: 400, color: C.coffee }); },
  });
  s.disc = paper(S.blob(260, 260, 807, 0.04, 56), { color: C.mustardPale, edge: "torn", seed: 807, res: 1 });
  s.hill = paper(S.blob(420, 250, 808, 0.07, 56), { color: C.sagePale, edge: "torn", seed: 808, res: 1, amp: 4 });
  s.band = paper([[-1150, 0], [1150, 0], [1150, 300], [-1150, 300]], { color: C.kraftLight, edge: "torn", seed: 809, res: 1, amp: 4.5 });
  s.flags = [C.tomato, C.mustard, C.sageDark, C.white].map((c, i) => paper([[-19, 0], [19, 0], [0, 44]], { color: c, seed: 810 + i, edge: "cut", blur: 2 }));
  return s;
}

export function draw(ctx, t, s) {
  const e = s.e;
  ctx.save();
  camera(ctx, 960, 540, 1.0 + 0.022 * E.inOutSine(prog(t, s.start, e.end + 4)));

  put(ctx, s.disc, 1560, 380, { rot: 0.01 * t, sh: 0.6, lift: 0.7 });
  put(ctx, s.hill, 300, 760, { rot: 0.08, sh: 0.6, lift: 0.7 });
  put(ctx, s.band, 960, 968, { lift: 0.8 });
  // bunting
  ctx.strokeStyle = C.coffee; ctx.lineWidth = 2.4;
  ctx.beginPath(); ctx.moveTo(-40, 70); ctx.quadraticCurveTo(960, 190, 1960, 60); ctx.stroke();
  for (let i = 1; i < 16; i++) {
    const u = i / 16, v = 1 - u, x = v * v * -40 + 2 * u * v * 960 + u * u * 1960, y = v * v * 70 + 2 * u * v * 190 + u * u * 60;
    put(ctx, s.flags[i % 4], x, y, { rot: 0.1 * Math.sin(t * 1.3 + i * 0.9), lift: 0.6 });
  }

  // "The agent suggests." and the helper hops in with an idea
  writeOn(ctx, s.l1, 960, 322, E.inOut(prog(t, e.a - 0.05, e.a + 0.95)), { rot: -0.012 });
  const hopIn = prog(t, e.a - 0.55, e.a - 0.02), hx = lerp(-180, 300, E.out(hopIn)), hy = 640 - 150 * 4 * hopIn * (1 - hopIn) * (hopIn < 1 ? 1 : 0);
  const sq = 1 - swing(t - (e.a - 0.02), 0.2, 2.6, 6);
  const beak = drawBird(ctx, s.bird, hx, hy, { s: 1.75, flip: 1, squash: sq, wing: -0.6 * (1 - E.out(prog(t, e.a - 0.02, e.a + 0.3))) - 0.4 * bump(t, e.end + 1.2, e.end + 1.7), tilt: 0.05 * Math.sin(t * 1.6), look: [0.7 * E.inOut(prog(t, e.b - 0.1, e.b + 0.3)), -0.1], blink: bump(t, e.a + 0.8, e.a + 1.0) + bump(t, e.end + 1.9, e.end + 2.1) });
  hangTag(ctx, s.idea, beak[0], beak[1] + 2, 30, swing(t - (e.a - 0.02), -0.3, 1.2, 1.5) + 0.03 * Math.sin(t * 1.4), { lift: 1.3, sw: 2.6 });
  track(ctx, "card:bird", hx, hy);

  // "The rules decide." and the rulebook lands, stamps on top
  writeOn(ctx, s.l2, 960, 474, E.inOut(prog(t, e.b - 0.05, e.b + 0.9)), { rot: 0.008 });
  ctx.save(); ctx.translate(1010, 540);
  stroke(ctx, s.under, { color: C.tomato, w: 7, to: E.inOut(prog(t, e.b + 0.75, e.b + 1.2)) });
  ctx.restore();
  const drop = spring(t - (e.b - 0.3), 2.2, 0.6);
  if (t > e.b - 0.3) {
    const bx = 1610, by = 500 - 900 * (1 - drop), rot = 0.045 + 0.1 * (1 - drop);
    ["no", "adj", "ok"].forEach((k, i) => {
      const d = spring(t - (e.b + 0.34 + i * 0.12), 2.6, 0.5);
      if (d > 0) put(ctx, s.T[k], bx + 84 - i * 82, by - 158 - 400 * (1 - d), { s: 0.62, rot: 0.045 + (i - 1) * 0.04, lift: 0.8 });
    });
    drawClosedBook(ctx, s.book, bx, by, { rot, s: 0.62, lift: 1.5 });
    track(ctx, "card:book", bx, by);
  }

  // the name, and where to find it
  const pn = spring(t - e.name, 2.1, 0.55);
  if (pn > 0) {
    put(ctx, s.plate, 960, 714, { rot: -0.02 + 0.1 * (1 - Math.min(1, pn)), s: 0.4 + 0.6 * pn, lift: 2 });
    for (const [dx, r, d] of [[-300, -0.7, 0.3], [304, 0.62, 0.42]]) {
      const on = prog(t, e.name + d, e.name + d + 0.04);
      put(ctx, s.props.tapeA, 960 + dx, 714 - 84, { rot: r, a: on, s: 1 + 0.6 * (1 - E.out(prog(t, e.name + d, e.name + d + 0.22))), lift: 0.5 });
    }
  }
  const pu = spring(t - e.url, 2.2, 0.75);
  if (pu > 0) put(ctx, s.url, 960, 900 + 260 * (1 - pu), { rot: 0.006 });
  ctx.restore();
}
