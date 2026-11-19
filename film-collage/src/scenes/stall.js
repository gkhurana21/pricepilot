// Scenes 2 to 4, one continuous shot along a street of paper.
//   2. The shopkeeper at her coffee stall, changing a price by hand. Carefully. Nervously.
//   3. The helper arrives, reads the order history and suggests $17.62 for the $20.00 coffee.
//   4. It never gets the last word: a gate comes down, the rulebook opens, her hand writes the
//      rules in it, and the rule called "margin floor" turns $17.62 into $18.99.

import { C, FONT, S, paper, piece, put, ink, label, wob, stroke, P, along } from "../lib/paper.js";
import { E, prog, spring, swing, settle, tween, bump, lerp, clamp, TAU, mulberry } from "../lib/util.js";
import { makeTag, hangTag, drawBird, drawBook, drawKeeper, BOOK } from "../cast.js";
import { track, writeOn } from "./common.js";
import { W, H } from "../timeline.js";

const GROUND = 870, TOP = 626;               // ground line; the counter's working surface
const KEEPER = [960, 640];
const PEGS = [660, 840, 1020];               // Subscription, Brazil, Kenya
const PERCH = [1292, TOP];                   // where the helper lands on the counter
const CRATE = [1670, 720];                   // the box it stands on at the gate
const GATE = [2250, 660], ARM = 350, ARM_OPEN = 1.36;
const BOOKAT = [2790, 440];
const ROWS = [-62, 44, 97, 203];             // ruled lines on the right-hand page (book coordinates)

export function events(tl) {
  const p = tl.p;
  const e = {
    a: p("02a").start, hand: tl.word("02a", "hand"), careful: p("02b").start, nervous: p("02c").start, calm: p("02c").end,
    h: p("03a").start, helper: tl.word("03a", "helper"), reads: p("03b").start, suggests: tl.word("03b", "suggests"),
    g: p("04a").start, never: tl.word("04a", "never"), book: p("04b").start, rulebook: tl.word("04b", "rulebook"),
    r1: p("04c").start, r1e: p("04c").end, r2: p("04d").start, r2e: p("04d").end, r3: p("04e").start, r3e: p("04e").end,
  };
  e.land = e.helper + 0.05;                  // the helper touches down on the word
  e.fly = e.land - 1.25;
  e.go = e.g - 0.1;                          // it sets off for the gate
  e.hops = [e.go + 0.5, e.go + 0.98, e.go + 1.5];
  e.shut = e.never - 0.15;                   // the gate arm starts down
  e.drop = e.book - 0.4;                     // the rulebook lands on its stand
  e.open = e.rulebook - 0.05;
  // The verdict is given in the pause after the hand stops writing, one thing at a time.
  e.under = e.r3e + 0.1;                     // "margin floor" underlined
  e.strike = e.under + 0.6;                  // $17.62 crossed out
  e.fix = e.strike + 0.55;                   // $18.99 comes down from the gate
  return e;
}

export function cues(tl) {
  const e = events(tl);
  return [
    { t: e.hand - 0.9, s: "paper", g: 0.45 }, { t: e.careful + 0.1, s: "scratch", g: 0.3, d: 0.5 },
    { t: e.nervous + 0.05, s: "scratch", g: 0.45, d: 0.7 }, { t: e.calm + 0.75, s: "tap", g: 0.4 },
    { t: e.fly + 0.15, s: "flutter", g: 0.6, d: 0.9 }, { t: e.land, s: "tap", g: 0.55 }, { t: e.land + 0.12, s: "chirp", g: 0.6 },
    { t: e.reads + 0.05, s: "unroll", g: 0.55, d: 0.9 }, { t: e.suggests - 0.05, s: "pop", g: 0.7 }, { t: e.suggests + 0.25, s: "chirp", g: 0.45 },
    { t: e.hops[0], s: "tap", g: 0.4 }, { t: e.hops[1], s: "tap", g: 0.35 }, { t: e.hops[2], s: "knock", g: 0.4 },
    { t: e.shut + 0.02, s: "creak", g: 0.55 }, { t: e.shut + 0.42, s: "knock", g: 0.7 },
    { t: e.drop + 0.36, s: "thump", g: 0.8 }, { t: e.open + 0.1, s: "flip", g: 0.75 },
    { t: e.r1 + 0.02, s: "scratch", g: 0.5, d: e.r1e - e.r1 - 0.1 }, { t: e.r2 + 0.02, s: "scratch", g: 0.5, d: e.r2e - e.r2 - 0.1 },
    { t: e.r3 + 0.02, s: "scratch", g: 0.5, d: e.r3e - e.r3 - 0.3 },
    { t: e.under, s: "scratch", g: 0.55, d: 0.38 }, { t: e.strike, s: "scratch", g: 0.6, d: 0.32 }, { t: e.fix + 0.3, s: "ding", g: 0.55 }, { t: e.fix + 0.28, s: "paper", g: 0.6 },
  ];
}

function mound(w, h, n = 40) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const u = i / n; pts.push([(u - 0.5) * w, -h * Math.sin(Math.PI * u) ** 0.85]); }
  pts.push([w / 2, 60], [-w / 2, 60]);
  return pts;
}

export function build(A, tl) {
  const s = { e: events(tl), bird: A.bird, book: A.book, keeper: A.keeper, stamps: A.stamps, hand: A.hand, props: A.props };
  const r = mulberry(300);

  // ----- the street -----
  s.sun = paper(S.blob(128, 128, 301, 0.03, 56), { color: C.mustardPale, edge: "torn", seed: 301, res: 1 });
  s.hillA = paper(mound(1500, 330), { color: C.sagePale, edge: "torn", seed: 302, res: 1, amp: 4 });
  s.hillB = paper(mound(1250, 250), { color: C.sage, edge: "torn", seed: 303, res: 1, amp: 4, grain: 1 });
  s.hillC = paper(mound(1700, 380), { color: C.sagePale, edge: "torn", seed: 304, res: 1, amp: 4 });
  s.cloud = paper(S.blob(150, 44, 305, 0.14, 44), { color: C.white, edge: "torn", seed: 305, res: 1, amp: 2.4 });
  s.cloud2 = paper(S.blob(110, 36, 306, 0.14, 40), { color: C.white, edge: "torn", seed: 306, res: 1, amp: 2.4 });
  s.ground = paper([[-400, 0], [3900, 0], [3900, 330], [-400, 330]], { color: C.kraftLight, edge: "torn", seed: 307, res: 1, amp: 4.5 });

  // ----- the stall -----
  const plank = Array.from({ length: 7 }, (_, i) => wob(P.line(600 + i * 120 + (r() - 0.5) * 14, 660, 600 + i * 120 + (r() - 0.5) * 10, 866), { amp: 1.4, seed: 310 + i }));
  s.front = paper(S.move(S.rect(820, 236), 960, 754), {
    color: C.kraft, seed: 311, edge: "cut",
    draw(g) {
      for (const pl of plank) stroke(g, pl, { color: C.kraftDark, w: 2.4, a: 0.75 });
      g.fillStyle = C.kraftDark; g.fillRect(540, 846, 840, 30);
    },
  });
  s.slab = paper(S.move(S.rrect(880, 30, 8), 960, 641), { color: C.coffee, seed: 312, edge: "cut", blur: 4 });
  s.post = paper(S.rect(22, 376), { color: C.coffee, seed: 313, edge: "cut", blur: 3 });
  const AW = { t0: 548, t1: 1372, b0: 506, b1: 1414, ty: 150, by: 258, n: 14 };
  const aw = [[AW.t0, AW.ty], [AW.t1, AW.ty], [AW.b1, AW.by]];
  for (let i = AW.n - 1; i >= 0; i--) {
    const x1 = lerp(AW.b0, AW.b1, (i + 1) / AW.n), x0 = lerp(AW.b0, AW.b1, i / AW.n);
    for (let k = 1; k <= 7; k++) { const a = (k / 8) * Math.PI; aw.push([lerp(x1, x0, (1 - Math.cos(a)) / 2), AW.by + Math.sin(a) * 34]); }
    aw.push([x0, AW.by]);
  }
  s.awning = paper(aw, {
    color: C.cream, seed: 314, edge: "cut", blur: 7,
    draw(g) {
      g.fillStyle = C.tomato;
      for (let i = 0; i < AW.n; i += 2) {
        g.beginPath();
        g.moveTo(lerp(AW.t0, AW.t1, i / AW.n), AW.ty - 4); g.lineTo(lerp(AW.t0, AW.t1, (i + 1) / AW.n), AW.ty - 4);
        g.lineTo(lerp(AW.b0, AW.b1, (i + 1) / AW.n), AW.by + 40); g.lineTo(lerp(AW.b0, AW.b1, i / AW.n), AW.by + 40); g.fill();
      }
      g.fillStyle = "rgba(60,40,24,0.10)"; g.fillRect(480, AW.by - 3, 960, 6);
    },
  });
  s.sign = paper(S.rrect(310, 86, 18), {
    color: C.kraftLight, seed: 315, edge: "cut", blur: 4,
    draw(g) { ink(g, "coffee", 0, 24, { size: 84, color: C.coffee }); },
  });
  s.cup = paper([[-22, -56], [22, -56], [17, 0], [-17, 0]], { color: C.white, seed: 316, edge: "cut", blur: 2.5, draw(g) { g.fillStyle = C.tomato; g.fillRect(-30, -40, 60, 22); } });
  s.bag = paper([[-34, -92], [30, -98], [36, 0], [-38, 0]], {
    color: C.kraftDark, seed: 317, edge: "cut", blur: 3,
    draw(g) { g.fillStyle = C.cream; g.fillRect(-22, -62, 44, 34); g.fillStyle = C.coffee; g.beginPath(); g.ellipse(0, -45, 9, 12, 0.4, 0, TAU); g.fill(); g.fillStyle = "rgba(44,32,25,0.25)"; g.fillRect(-40, -100, 80, 14); },
  });
  s.steam = [0, 1].map((i) => wob(P.bez([0, 0], [-12, -18], [12, -34], [-2, -56], 14), { amp: 1.5, seed: 318 + i }));
  s.pot = paper([[-52, -84], [52, -84], [40, 0], [-40, 0]], { color: C.tomatoDark, seed: 320, edge: "cut", blur: 4 });
  s.leaf = paper([[0, 0], [-24, -46], [-14, -104], [0, -132], [16, -100], [24, -44]], {
    color: C.sageDark, seed: 321, edge: "torn", amp: 1.6, blur: 3,
    draw(g) { stroke(g, wob(P.line(0, -6, 0, -116), { amp: 1.2, seed: 7 }), { color: C.sage, w: 2.4 }); },
  });
  s.flags = [C.tomato, C.mustard, C.sageDark, C.cream].map((c, i) => paper([[-17, 0], [17, 0], [0, 40]], { color: c, seed: 322 + i, edge: "cut", blur: 2 }));
  s.peg = paper(S.ellipse(6, 6, 16), { color: C.coffee, seed: 326, blur: 1.5 });
  s.tags = [
    makeTag({ w: 150, h: 176, name: "Subscription", nameSize: 27, price: "$28.00", seed: 331 }),
    makeTag({ w: 150, h: 176, name: "Brazil", price: "$19.00", seed: 332 }),
    makeTag({ w: 150, h: 176, name: "Kenya", price: "$20.00", seed: 333 }),
  ];
  s.idea = makeTag({ w: 150, h: 176, name: "Kenya", small: "suggested", price: "$17.62", color: C.mustardPale, seed: 334 });
  s.fixed = makeTag({ w: 150, h: 176, name: "Kenya", small: "margin floor", price: "$18.99", seed: 335 });
  s.strikeLine = wob(P.line(-58, 6, 58, -8), { amp: 1.6, seed: 336, step: 5 });
  s.worry = wob(P.bez([-34, 8], [-70, -60], [50, -80], [26, -20], 22).concat(P.bez([26, -20], [8, 24], [-40, -30], [-4, -46], 16).slice(1), P.bez([-4, -46], [24, -60], [56, -10], [30, 14], 14).slice(1)), { amp: 1.6, seed: 337, step: 5 });

  // ----- the order history -----
  const rowsO = Array.from({ length: 9 }, (_, i) => wob(P.line(-42, 74 + i * 27, 14 + r() * 26, 74 + i * 27), { amp: 1.5, seed: 340 + i, wave: 12 }));
  const sums = Array.from({ length: 9 }, (_, i) => wob(P.line(36, 74 + i * 27, 46, 74 + i * 27), { amp: 1, seed: 350 + i }));
  s.orders = paper([[-60, 0], [60, 0], [60, 330], [-60, 330]], {
    color: C.white, seed: 360, edge: "cut", blur: 3,
    draw(g) {
      ink(g, "orders", 0, 42, { size: 40, color: C.coffee });
      for (const o of rowsO) stroke(g, o, { color: C.coffee, w: 2.2, a: 0.7 });
      for (const o of sums) stroke(g, o, { color: C.tomato, w: 2.4, a: 0.8 });
    },
  });
  s.roll = paper(S.rrect(136, 30, 14), { color: C.cream, seed: 361, edge: "cut", blur: 3, draw(g) { g.strokeStyle = "rgba(75,52,37,0.35)"; g.lineWidth = 1.6; for (const y of [-6, 2, 9]) { g.beginPath(); g.moveTo(-64, y); g.lineTo(64, y + 1); g.stroke(); } } });

  // ----- the gate and the rulebook's stand -----
  const cross = [wob(P.line(-62, -62, 62, 62), { amp: 1.5, seed: 371 }), wob(P.line(62, -62, -62, 62), { amp: 1.5, seed: 372 })];
  s.crate = paper(S.move(S.rect(150, 150), 0, 75), {
    color: C.kraftDark, seed: 370, edge: "cut", blur: 4,
    draw(g) { g.save(); g.translate(0, 75); for (const c of cross) stroke(g, c, { color: C.coffee, w: 3, a: 0.55 }); g.strokeStyle = "rgba(75,52,37,0.55)"; g.lineWidth = 3; g.strokeRect(-64, -64, 128, 128); g.restore(); },
  });
  s.gpost = paper(S.move(S.rect(26, 236), 0, 100), { color: C.coffee, seed: 373, edge: "cut", blur: 3 });
  s.gbase = paper([[-52, 0], [52, 0], [36, -30], [-36, -30]], { color: C.kraftDark, seed: 374, edge: "cut", blur: 3 });
  s.arm = paper([[-ARM, -15], [34, -15], [34, 15], [-ARM, 15]], {
    color: C.cream, seed: 375, edge: "cut", blur: 4,
    draw(g) { g.fillStyle = C.tomato; for (let x = -ARM - 30; x < 40; x += 62) { g.beginPath(); g.moveTo(x, 18); g.lineTo(x + 30, 18); g.lineTo(x + 54, -18); g.lineTo(x + 24, -18); g.fill(); } },
  });
  s.weight = paper(S.ellipse(22, 22, 28), { color: C.coffee, seed: 376, blur: 3 });
  s.cap = paper(S.ellipse(14, 14, 24), { color: C.mustard, seed: 377, blur: 2 });
  const slat = Array.from({ length: 5 }, (_, i) => wob(P.line(-290 + i * 145, -78, -290 + i * 145 + 3, 78), { amp: 1.4, seed: 380 + i }));
  s.cabinet = paper(S.rrect(720, 168, 10), {
    color: C.kraft, seed: 378, edge: "cut", blur: 6,
    draw(g) { for (const sl of slat) stroke(g, sl, { color: C.kraftDark, w: 2.4, a: 0.7 }); g.fillStyle = C.kraftDark; g.fillRect(-320, -52, 640, 124); g.fillStyle = "rgba(44,32,25,0.28)"; g.fillRect(-320, -52, 640, 14); },
  });
  s.rules = [
    label("margin floor", { size: 54, color: C.ink, align: "left", pencil: 0.18 }),
    label("how far a price", { size: 54, color: C.ink, align: "left", pencil: 0.18 }),
    label("may move", { size: 54, color: C.ink, align: "left", pencil: 0.18 }),
    label("what is off limits", { size: 54, color: C.ink, align: "left", pencil: 0.18 }),
  ];
  s.underline = wob(P.line(0, 0, s.rules[0].tw + 8, -3), { amp: 1.8, seed: 390, step: 5 });
  return s;
}

// A hop from a to b: across in a straight line, up and over in an arc.
function hop(t, t0, t1, a, b, hgt) {
  const u = prog(t, t0, t1);
  return [lerp(a[0], b[0], u), lerp(a[1], b[1], u) - hgt * 4 * u * (1 - u)];
}

export function draw(ctx, t, s, tl) {
  const e = s.e, Kp = s.keeper;

  // ----- camera: wide on the stall, in on the counter, then along the street to the gate -----
  //           and last a move in on the tags as the rulebook has its say
  const k1 = E.inOut(prog(t, e.h - 0.35, e.h + 1.5)), k2 = E.inOut(prog(t, e.g - 0.35, e.g + 2.1)), k3 = E.inOut(prog(t, e.under - 0.1, e.fix + 0.55));
  const cam = {
    x: 960 + 170 * k1 + (2400 - 1130) * k2 + 14 * E.inOutSine(prog(t, e.g + 2.1, e.under)) - 224 * k3 - 12 * E.inOutSine(prog(t, e.fix + 0.4, e.fix + 5)),
    y: 506 + 62 * k1 - 44 * k2 + 42 * k3,
    z: 1.06 + 0.04 * E.inOutSine(prog(t, e.a - 1, e.h)) + 0.22 * k1 - 0.32 * k2 + 0.02 * E.inOutSine(prog(t, e.g + 2.1, e.under)) + 0.26 * k3 + 0.018 * E.inOutSine(prog(t, e.fix + 0.4, e.fix + 5)),
  };
  const layer = (k, fn) => {
    ctx.save();
    const z = 1 + (cam.z - 1) * k;
    ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-W / 2 - (cam.x - 960) * k, -H / 2 - (cam.y - 540) * k);
    fn();
    ctx.restore();
  };

  layer(0.18, () => { put(ctx, s.sun, 330, 250, { rot: 0.015 * t, sh: 0.6 }); put(ctx, s.cloud, 1330 - 6 * t, 150, { sh: 0.5 }); put(ctx, s.cloud2, 2040 - 8 * t, 260, { sh: 0.5 }); });
  layer(0.38, () => { put(ctx, s.hillC, 1750, 900, { sh: 0.6 }); put(ctx, s.hillA, 420, 900, { sh: 0.6 }); });
  layer(0.6, () => { put(ctx, s.hillB, 1250, 895, { sh: 0.7 }); put(ctx, s.hillB, 2700, 900, { sh: 0.7, sx: -1.15, sy: 1.1 }); });

  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.scale(cam.z, cam.z); ctx.translate(-cam.x, -cam.y);
  put(ctx, s.ground, 0, GROUND, { lift: 0.8 });

  // ----- the stall, back to front -----
  // bunting
  const bunt = (x0, y0, x1, y1, n, ph) => {
    ctx.strokeStyle = C.coffee; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo((x0 + x1) / 2, Math.max(y0, y1) + 46, x1, y1); ctx.stroke();
    for (let i = 1; i < n; i++) {
      const u = i / n, v = 1 - u, x = v * v * x0 + 2 * u * v * ((x0 + x1) / 2) + u * u * x1, y = v * v * y0 + 2 * u * v * (Math.max(y0, y1) + 46) + u * u * y1;
      put(ctx, s.flags[(i + ph) % 4], x, y, { rot: 0.1 * Math.sin(t * 1.3 + i * 0.9 + ph), lift: 0.6 });
    }
  };
  bunt(548, 170, -40, 40, 9, 0);
  bunt(1372, 170, 1960, 30, 9, 2);
  // potted plant
  for (let i = 0; i < 5; i++) put(ctx, s.leaf, 330 + (i - 2) * 12, GROUND - 78, { rot: (i - 2) * 0.42 + 0.035 * Math.sin(t * 0.9 + i), lift: 0.7 });
  put(ctx, s.pot, 330, GROUND + 4);
  put(ctx, s.post, 585, 454); put(ctx, s.post, 1335, 454);

  // the order history: a roll taped to the post, let down when the helper reads it
  const un = E.inOut(prog(t, e.reads - 0.05, e.reads + 0.95));
  const olen = 34 + 296 * un;
  ctx.save();
  ctx.translate(1438, 298); ctx.rotate(0.02 + 0.012 * Math.sin(t * 1.1));
  ctx.save(); ctx.beginPath(); ctx.rect(-90, -20, 180, olen + 20); ctx.clip(); put(ctx, s.orders, 0, 0, { lift: 0.8 }); ctx.restore();
  put(ctx, s.roll, 0, olen, { lift: 1.2 });
  put(ctx, s.props.tapeB, -4, 2, { rot: -0.06, lift: 0.4 });
  ctx.restore();

  // the shopkeeper
  const lookAtBird = E.inOut(prog(t, e.fly + 0.2, e.fly + 0.7));
  const nerv = E.inOut(prog(t, e.nervous - 0.1, e.nervous + 0.3)) * (1 - E.inOut(prog(t, e.calm + 0.3, e.calm + 0.8)));
  const care = E.inOut(prog(t, e.careful - 0.3, e.careful + 0.3)) * (1 - E.inOut(prog(t, e.calm + 0.3, e.calm + 0.8)));
  const shake = nerv * (2.6 * Math.sin(t * TAU * 6.5) + 1.4 * Math.sin(t * TAU * 9.2 + 1));
  // right hand: rest -> the Kenya tag's peg -> lift the tag -> put it back -> rest
  const reach = E.inOut(prog(t, e.hand - 1.75, e.hand - 1.0)), lift = E.inOut(prog(t, e.hand - 0.95, e.hand - 0.1));
  const back = E.inOut(prog(t, e.calm + 0.25, e.calm + 0.8)), rest = E.inOut(prog(t, e.calm + 0.8, e.calm + 1.2));
  const pegK = [PEGS[2], 668], holdAt = [1062, 512], restR = [1052, 610];
  let rh = [lerp(restR[0], pegK[0], reach), lerp(restR[1], pegK[1] - 8, reach)];
  rh = [lerp(rh[0], holdAt[0], lift - back), lerp(rh[1], holdAt[1], lift - back)];
  rh = [lerp(rh[0], restR[0], rest) + shake * 0.6, lerp(rh[1], restR[1], rest) + shake];
  // left hand holds a pencil: rest -> hovers by the tag -> rest
  const restL = [872, 606], hover = [946, 562];
  const lh = [lerp(restL[0], hover[0], care) - shake * 0.8, lerp(restL[1], hover[1], care) + 5 * Math.sin(t * 2.2) * care + shake * 0.7];
  const idle = Math.sin(t * 1.4);
  const lookBird = lookAtBird * (1 - E.inOut(prog(t, e.suggests - 0.2, e.suggests + 0.2)));
  const lookIdea = E.inOut(prog(t, e.suggests - 0.2, e.suggests + 0.2));
  const blinkAt = (t0) => bump(t, t0, t0 + 0.22);
  const blink = blinkAt(e.a + 0.2) + blinkAt(e.careful + 0.5) + blinkAt(e.calm + 0.95) + blinkAt(e.land + 0.5) + blinkAt(e.suggests + 0.9) + blinkAt(e.a - 0.9);
  const pose = {
    lHand: lh, rHand: rh,
    look: [0.5 * (1 - lookAtBird) * reach + 1.0 * lookBird + 0.9 * lookIdea - 0.2 * care, 0.9 * (1 - lookAtBird) * (0.4 + 0.6 * reach) * (1 - lift + back) + 0.2 * care - 0.25 * lookBird + 0.5 * lookIdea],
    blink, worry: 0.25 * care + 0.75 * nerv, smile: 0.55 + 0.35 * lookAtBird - 0.3 * care,
    tilt: 0.03 * idle + 0.07 * lookAtBird - 0.05 * care + shake * 0.004, bob: 1.5 * idle + shake * 0.3,
    hold(l) { put(ctx, s.bird.pencil, l.hx - 26, l.hy + 12, { rot: -0.5 + 0.25 * care, s: 1.25, lift: 0.6 }); },   // her pencil
  };
  drawKeeper(ctx, Kp, KEEPER[0], KEEPER[1], { ...pose, part: "body" });
  // nervous: a pencil tangle over her head and a few drops
  const wr = E.inOut(prog(t, e.nervous, e.nervous + 0.55)), wo = E.inOut(prog(t, e.calm + 0.35, e.calm + 0.8));
  if (wr > 0 && wo < 1) {
    ctx.save(); ctx.translate(KEEPER[0] + 112, KEEPER[1] - 296); ctx.rotate(0.08 * Math.sin(t * 5)); ctx.scale(1.25, 1.25);
    stroke(ctx, s.worry, { color: C.coffee, w: 3.2, from: wo, to: wr });
    ctx.restore();
  }
  for (let i = 0; i < 3; i++) {
    const d = t - (e.nervous + 0.12 + i * 0.24), side = i === 1 ? 1 : -1;
    if (d > 0 && d < 1.1) put(ctx, Kp.drop, KEEPER[0] + side * (70 + 60 * d), KEEPER[1] - 250 - 46 * d + 150 * d * d, { rot: side * 0.5, s: spring(d, 4, 0.6), a: 1 - prog(d, 0.7, 1.1), lift: 0.6 });
  }

  // counter and what stands on it
  put(ctx, s.front, 0, 0);
  put(ctx, s.slab, 0, 0);
  for (const [i, x] of [716, 768].entries()) {
    put(ctx, s.cup, x, TOP + 1, { lift: 0.6 });
    ctx.save(); ctx.translate(x + 3 * Math.sin(t * 1.2 + i), TOP - 62); stroke(ctx, s.steam[i], { color: C.coffee, w: 2.4, a: 0.45 }); ctx.restore();
  }
  put(ctx, s.bag, 628, TOP + 1, { rot: -0.03, lift: 0.7 });
  drawKeeper(ctx, Kp, KEEPER[0], KEEPER[1], { ...pose, part: "arms" });

  // the price tags along the front of the counter
  for (let i = 0; i < 3; i++) {
    put(ctx, s.peg, PEGS[i], 668, { lift: 0.5 });
    const th = 0.035 * Math.sin(t * 1.15 + i * 2.1);
    if (i === 2) {
      // Kenya: lifted off its peg by her right hand, looked at, hung back
      const up = lift - back;
      const sw = th * (1 - up) + swing(t - (e.hand - 0.95), 0.2, 1.3, 1.5) + swing(t - (e.calm + 0.8), -0.16, 1.4, 1.8) + shake * 0.012;
      const [hx, hy] = hangTag(ctx, s.tags[2], up > 0 ? rh[0] : PEGS[2], up > 0 ? rh[1] + 8 : 668, 18, sw, { lift: 1 + 2 * up });
      track(ctx, "stall:kenya", hx, hy);
      if (up > 0.01) put(ctx, Kp.hand, rh[0], rh[1], { lift: 0.6 });
    } else hangTag(ctx, s.tags[i], PEGS[i], 668, 18, th);
  }

  put(ctx, s.awning, 0, 0, { lift: 2 });
  put(ctx, s.sign, 960, 128, { rot: -0.02 + 0.006 * Math.sin(t * 0.8), lift: 1.4 });

  // ----- the gate, the stand, the rulebook -----
  put(ctx, s.crate, CRATE[0], CRATE[1], { rot: 0.01 });
  track(ctx, "stall:crate", CRATE[0], CRATE[1]);
  put(ctx, s.cabinet, BOOKAT[0], 786);
  for (const [i, k] of ["ok", "adj", "no"].entries()) put(ctx, s.stamps[k], BOOKAT[0] - 190 + i * 190, 850, { s: 0.62, lift: 0.6 });
  const bdrop = spring(t - e.drop, 2.3, 0.62);
  if (t > e.drop) {
    const open = E.inOut(prog(t, e.open, e.open + 0.85));
    drawBook(ctx, s.book, BOOKAT[0], BOOKAT[1] - 900 * (1 - bdrop), { open, rot: -0.012 + 0.08 * (1 - bdrop), ribbon: swing(t - e.drop - 0.3, 0.3, 1.3, 1.6) });
    track(ctx, "stall:book", BOOKAT[0], BOOKAT[1] - 900 * (1 - bdrop));
    // the rules, written in by her hand
    const span = [[e.r1, e.r1e - 0.15], [e.r2, lerp(e.r2, e.r2e, 0.6)], [lerp(e.r2, e.r2e, 0.62), e.r2e - 0.1], [e.r3, Math.min(e.r3e - 0.2, e.under - 0.05)]];
    const tx = BOOKAT[0] - 372;
    let tip = null;
    ctx.save();
    ctx.translate(BOOKAT[0], BOOKAT[1]); ctx.rotate(-0.012); ctx.translate(-BOOKAT[0], -BOOKAT[1]);
    span.forEach(([a, b], i) => {
      const p = prog(t, a, b), y = BOOKAT[1] + ROWS[i] - 15;
      writeOn(ctx, s.rules[i], tx, y, p);
      if (i !== 2) { ctx.fillStyle = C.tomato; ctx.globalAlpha = spring(t - a + 0.1, 3, 0.6) > 0 ? Math.min(1, prog(t, a - 0.12, a)) : 0; ctx.beginPath(); ctx.arc(tx - 20, y + 4, 6 * Math.min(1.2, spring(t - a + 0.12, 3, 0.55)), 0, TAU); ctx.fill(); ctx.globalAlpha = 1; }
    });
    const ul = E.inOut(prog(t, e.under, e.under + 0.42));
    ctx.save(); ctx.translate(tx - 4, BOOKAT[1] + ROWS[0] + 9); stroke(ctx, s.underline, { color: C.tomato, w: 5, to: ul }); ctx.restore();
    ctx.restore();
    // where the pencil point is: on the line being written, or travelling between lines
    const stops = [];
    stops.push({ t: e.r1 - 0.6, p: [BOOKAT[0] + 260, BOOKAT[1] + 720] });
    span.forEach(([a, b], i) => { const y = BOOKAT[1] + ROWS[i] - 4; stops.push({ t: a, p: [tx, y] }, { t: b, p: [tx + s.rules[i].tw, y] }); });
    stops.push({ t: e.under, p: [tx - 4, BOOKAT[1] + ROWS[0] + 9] }, { t: e.under + 0.42, p: [tx + s.rules[0].tw + 4, BOOKAT[1] + ROWS[0] + 6] }, { t: e.under + 1.35, p: [BOOKAT[0] + 300, BOOKAT[1] + 760] });
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i].t && t <= stops[i + 1].t) {
        const writing = i % 2 === 1 && i < 9 || i === 9;
        const u = writing ? prog(t, stops[i].t, stops[i + 1].t) : E.inOut(prog(t, stops[i].t, stops[i + 1].t));
        tip = [lerp(stops[i].p[0], stops[i + 1].p[0], u), lerp(stops[i].p[1], stops[i + 1].p[1], u) + (writing ? 5 * Math.sin(t * TAU * 4.5) : -22 * Math.sin(Math.PI * u))];
      }
    }
    if (tip) {
      // she writes from below and to the right, so her hand never covers what is already written
      put(ctx, s.bird.pencil, tip[0] - Math.cos(-2.25) * 108, tip[1] - Math.sin(-2.25) * 108, { rot: -2.25, s: 1.5, lift: 1.2 });
      put(ctx, s.hand, tip[0] + 40, tip[1] + 50, { rot: 2.52, lift: 3 });
      track(ctx, "stall:pencil", tip[0], tip[1]);
    }
  }

  // ----- the helper -----
  // on the counter: flies in, reads, turns and holds out its idea; then hops down the street
  const going = t >= e.go;
  let bx, by, flip, wing = 0, squash = 1, tilt = 0, look = [0, 0], legs = 1;
  const stops = [PERCH, [1440, GROUND], [1558, GROUND], CRATE];
  const times = [e.go, ...e.hops];
  if (t < e.fly) { bx = null; }
  else if (t < e.land) {
    const u = E.outQuad(prog(t, e.fly, e.land)), v = 1 - u;
    const a = [1900, 60], b = [1700, 150], c = [1440, 470], d = PERCH;
    bx = v * v * v * a[0] + 3 * v * v * u * b[0] + 3 * v * u * u * c[0] + u * u * u * d[0];
    by = v * v * v * a[1] + 3 * v * v * u * b[1] + 3 * v * u * u * c[1] + u * u * u * d[1];
    flip = -1; wing = -0.75 + 0.75 * Math.sin(t * TAU * 5.2); legs = prog(t, e.land - 0.35, e.land); tilt = -0.1;
  } else if (!going) {
    [bx, by] = PERCH;
    // a paper puppet turns by flipping: faces left, right (to read), left (to offer), right (to set off)
    const t2 = Math.max(e.reads + 0.5, e.suggests - 0.5);
    const turn1 = E.inOut(prog(t, e.reads - 0.3, e.reads)), turn2 = E.inOut(prog(t, t2, t2 + 0.3)), turn3 = E.inOut(prog(t, e.go - 0.35, e.go - 0.05));
    flip = turn3 > 0 ? -Math.cos(Math.PI * turn3) : turn2 > 0 ? Math.cos(Math.PI * turn2) : -Math.cos(Math.PI * turn1);
    squash = 1 - swing(t - e.land, 0.2, 2.6, 6) - 0.05 * bump(t, e.suggests - 0.1, e.suggests + 0.25);
    wing = -0.75 * (1 - E.out(prog(t, e.land, e.land + 0.3))) - 0.5 * bump(t, e.suggests - 0.25, e.suggests + 0.35);
    const reading = E.inOut(prog(t, e.reads, e.reads + 0.4)) * (1 - turn2);
    tilt = -0.32 * reading + 0.06 * Math.sin(t * 5) * reading + 0.1 * E.inOut(prog(t, e.suggests - 0.2, e.suggests + 0.1));
    look = [0.4 * reading, (-0.6 + 0.9 * prog(t, e.reads + 0.3, e.suggests - 0.5)) * reading];
  } else {
    let i = 0;
    while (i < 2 && t > times[i + 1]) i++;
    [bx, by] = t >= times[3] ? CRATE : hop(t, times[i], times[i + 1], stops[i], stops[i + 1], i === 2 ? 120 : 70);
    flip = 1;
    for (const tt of e.hops) squash -= swing(t - tt, 0.16, 2.8, 6.5);
    wing = t < times[3] ? -0.35 - 0.3 * Math.sin((t - e.go) * TAU * 2.1) : -0.35 * (1 - E.out(prog(t, times[3], times[3] + 0.3)));
    wing -= 0.45 * bump(t, e.fix + 0.25, e.fix + 0.75);
    look = [0.6 * E.inOut(prog(t, e.shut, e.shut + 0.4)), -0.4 * E.inOut(prog(t, e.shut, e.shut + 0.3)) * (1 - E.inOut(prog(t, e.fix, e.fix + 0.3)))];
    tilt = -0.14 * E.inOut(prog(t, e.shut + 0.1, e.shut + 0.5)) * (1 - E.inOut(prog(t, e.book, e.book + 0.4))) - 0.1 * E.inOut(prog(t, e.drop + 0.2, e.drop + 0.5)) * (1 - E.inOut(prog(t, e.fix, e.fix + 0.4)));
  }
  if (bx !== null) {
    const bl = bump(t, e.land + 0.7, e.land + 0.9) + bump(t, e.suggests + 0.7, e.suggests + 0.9) + bump(t, e.book + 1.5, e.book + 1.7) + bump(t, e.r2 + 0.6, e.r2 + 0.8);
    // its idea: a tag pulled out as it says "suggests", carried to the gate
    const has = spring(t - (e.suggests - 0.1), 2.6, 0.5);
    const beak = drawBird(ctx, s.bird, bx, by, { flip, wing, squash, tilt, look, blink: bl, legs });
    track(ctx, "stall:bird", bx, by);
    if (has > 0) {
      let sw = -settle(t - (e.suggests - 0.1), 0.5, 1.25, 1.5);
      if (going) { sw = 0; for (const tt of [e.go, ...e.hops]) sw += swing(t - tt, -0.24, 1.3, 1.7); sw += 0.05 * Math.sin(t * 1.3); }
      ctx.save();
      const [hx, hy] = hangTag(ctx, s.idea, beak[0], beak[1] + 2, 34, sw, { s: has, lift: 1.4 });
      // the rulebook's verdict on it
      const st = E.inOut(prog(t, e.strike, e.strike + 0.36));
      if (st > 0) { ctx.translate(hx, hy); ctx.rotate(-sw * 1.15); ctx.translate(0, 105); stroke(ctx, s.strikeLine, { color: C.tomato, w: 6, to: st }); }
      ctx.restore();
      track(ctx, "stall:idea", hx, hy);
    }
  }

  // the gate arm comes down in front of it, and later hands down the price the rules allow
  const shut = spring(t - e.shut, 1.5, 0.5);
  const ang = ARM_OPEN * (1 - shut);
  put(ctx, s.gbase, GATE[0], GROUND + 4);
  put(ctx, s.gpost, GATE[0], GATE[1] - 10);
  const tipX = GATE[0] - Math.cos(ang) * (ARM - 8) - Math.sin(ang) * 12, tipY = GATE[1] - Math.sin(ang) * (ARM - 8) + Math.cos(ang) * 12;
  const fx = spring(t - e.fix, 1.9, 0.55);
  if (t > e.fix) {
    const [hx, hy] = hangTag(ctx, s.fixed, tipX, tipY - 2, 22 + 0 * fx, settle(t - e.fix - 0.1, 0.34, 1.2, 1.5) * prog(t, e.fix, e.fix + 0.1), { s: Math.min(1.08, fx), lift: 1.6 });
    track(ctx, "stall:fixed", hx, hy);
  }
  put(ctx, s.arm, GATE[0], GATE[1], { rot: ang, lift: 1.6 });
  put(ctx, s.weight, GATE[0] + Math.cos(ang) * 34, GATE[1] + Math.sin(ang) * 34, { lift: 1.2 });
  put(ctx, s.cap, GATE[0], GATE[1], { lift: 0.8 });
  track(ctx, "stall:armtip", tipX, tipY);
  ctx.restore();
}
