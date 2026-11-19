// The cast and props that appear in more than one scene: price tags, the helper (a small paper bird
// with a pencil), the rulebook, the three rubber stamps, the shopkeeper and her hand.
// build*() functions cut the paper once; draw*() functions pose it for a moment in time.

import { C, FONT, S, paper, piece, put, ink, label, wob, stroke, P, imprint, tape } from "./lib/paper.js";
import { TAU, elbow, clamp } from "./lib/util.js";

// ---------- price tags ----------

// Origin at the punched hole. `was` adds a smaller, struck-through old price above the price.
export function makeTag(o = {}) {
  const { w = 160, h = 190, color = C.white, name = "", price = "", was = null, small = null, seed = 1, priceColor = C.ink, res } = o;
  const lay = { name: 0.335, mid: 0.53, price: 0.83, solo: 0.8, ...(o.lay ?? {}) };
  const top = -h * 0.13;
  const nameSize = o.nameSize ?? w * 0.215, priceSize = o.priceSize ?? w * 0.31;
  const rule = wob(P.line(-w * 0.33, 0, w * 0.33, 0), { amp: 1.1, seed: seed + 3 });
  return paper(S.tag(w, h), {
    color, seed, edge: "cut", res, holes: [{ x: 0, y: 0, r: w * 0.03 + 2.5 }],
    draw(g) {
      g.strokeStyle = C.kraft;
      g.lineWidth = w * 0.028 + 2;
      g.beginPath(); g.arc(0, 0, w * 0.062 + 4.5, 0, TAU); g.stroke();
      let y = top + h * lay.name;
      if (name) {
        ink(g, name, 0, y, { size: nameSize, font: FONT.hand, weight: 700, color: C.coffee });
        g.save(); g.translate(0, y + nameSize * 0.3); stroke(g, rule, { color: C.kraftDark, w: Math.max(1.6, w * 0.011), a: 0.8 }); g.restore();
      }
      if (was || small) {
        const sz = priceSize * 0.5;
        y = top + h * lay.mid;
        ink(g, was ?? small, 0, y, { size: was ? sz : sz * 1.15, font: was ? FONT.print : FONT.hand, weight: was ? 400 : 600, color: C.coffee, a: 0.85 });
        if (was) {
          const tw = sz * 0.5 * was.length * 0.62;
          g.save(); g.translate(0, y - sz * 0.3);
          stroke(g, wob(P.line(-tw, 3, tw, -4), { amp: 1.2, seed: seed + 9 }), { color: C.tomato, w: Math.max(2.4, sz * 0.09) });
          g.restore();
        }
        ink(g, price, 0, top + h * lay.price, { size: priceSize, font: FONT.print, weight: 400, color: priceColor, bold: priceSize * 0.022 });
      } else {
        ink(g, price, 0, top + (name ? lay.solo : 0.66) * h, { size: priceSize, font: FONT.print, weight: 400, color: priceColor, bold: priceSize * 0.022 });
      }
    },
  });
}

// A tag hanging from a point by a short string, swung to angle th (radians, 0 = straight down).
export function hangTag(ctx, sp, ax, ay, len, th, o = {}) {
  const hx = ax + Math.sin(th) * len, hy = ay + Math.cos(th) * len;
  put(ctx, sp, hx, hy, { rot: -th * 1.15, ...o });
  ctx.save();
  ctx.strokeStyle = o.string ?? C.coffee;
  ctx.globalAlpha *= o.a ?? 1;
  ctx.lineWidth = o.sw ?? 2;
  ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(hx, hy); ctx.stroke();
  ctx.restore();
  return [hx, hy];
}

// ---------- the helper: a small paper bird with a pencil ----------

export function buildBird() {
  const B = {};
  B.tail = paper([[-34, -50], [-92, -84], [-80, -58], [-98, -40], [-40, -32]], { color: C.kraftDark, seed: 11, edge: "cut" });
  B.body = paper(S.move(S.blob(52, 43, 12, 0.05), 0, -46), {
    color: C.mustard, seed: 12, edge: "cut",
    draw(g) { g.fillStyle = C.mustardPale; g.beginPath(); g.ellipse(16, -30, 30, 22, -0.2, 0, TAU); g.fill(); },
  });
  B.head = paper(S.blob(31, 29, 13, 0.04), { color: C.mustard, seed: 13, edge: "cut" });           // origin: head centre
  B.tuft = paper([[-8, -22], [-15, -46], [-1, -30], [6, -50], [10, -22]], { color: C.mustard, seed: 14, edge: "cut", blur: 3 });
  B.beak = paper([[24, -8], [52, 1], [24, 9]], { color: C.tomato, seed: 15, edge: "cut", blur: 3 });
  const feather = [wob(P.line(-14, 2, -50, 8), { amp: 0.8, seed: 5 }), wob(P.line(-10, 10, -40, 16), { amp: 0.8, seed: 6 })];
  B.wing = paper([[8, -8], [-28, -15], [-68, 4], [-50, 22], [-18, 25], [6, 10]], {
    color: C.kraftDark, seed: 16, edge: "cut", blur: 3,
    draw(g) { for (const f of feather) stroke(g, f, { color: C.coffee, w: 2, a: 0.6 }); },
  });
  B.pencil = piece(96, 24, 14, 12, (g) => {
    g.fillStyle = C.tomato; g.fillRect(0, -5, 58, 10);
    g.fillStyle = C.mustardPale; g.fillRect(-9, -5, 9, 10);
    g.fillStyle = C.kraftLight; g.beginPath(); g.moveTo(58, -5); g.lineTo(72, 0); g.lineTo(58, 5); g.fill();
    g.fillStyle = C.ink; g.beginPath(); g.moveTo(67, -1.8); g.lineTo(72, 0); g.lineTo(67, 1.8); g.fill();
  }, { blur: 2.5 });
  return B;
}

// Draws the bird with its feet at (x, y). Returns where the beak tip is, for anything it carries.
// pose: flip (1 faces right, -1 left), s (scale), wing (radians, 0 folded), squash (1 = none),
//       tilt (head), look [dx, dy], blink (0..1), pencil (true to show it tucked under the wing).
export function drawBird(ctx, B, x, y, pose = {}) {
  const { flip = 1, s = 1, wing = 0, squash = 1, tilt = 0, look = [0, 0], blink = 0, pencil = true, lift = 1, legs = 1 } = pose;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(flip * s, s);
  // legs
  ctx.strokeStyle = C.coffee; ctx.lineWidth = 3; ctx.lineCap = "round";
  for (const lx of [-9, 13]) {
    ctx.beginPath(); ctx.moveTo(lx, -12 * squash); ctx.lineTo(lx, -1 + (1 - legs) * -8); ctx.moveTo(lx - 5, 0 + (1 - legs) * -8); ctx.lineTo(lx + 8, 0 + (1 - legs) * -8); ctx.stroke();
  }
  ctx.scale(1 / Math.sqrt(squash), squash);
  put(ctx, B.tail, 0, 0, { rot: wing * 0.12, lift });
  put(ctx, B.body, 0, 0, { lift });
  if (pencil) put(ctx, B.pencil, -30, -36, { rot: -0.62, lift: 0.6 });
  // head
  ctx.save();
  ctx.translate(34, -84);
  ctx.rotate(tilt);
  put(ctx, B.tuft, 0, 0, { lift: 0.6 });
  put(ctx, B.beak, 0, 0, { lift: 0.6 });
  put(ctx, B.head, 0, 0, { lift });
  ctx.fillStyle = C.ink;
  ctx.beginPath(); ctx.ellipse(9 + look[0] * 2.5, -5 + look[1] * 2.5, 4.6, 5.4 * (1 - 0.9 * blink), 0, 0, TAU); ctx.fill();
  ctx.fillStyle = C.white;
  ctx.beginPath(); ctx.arc(10.5 + look[0] * 2.5, -7 + look[1] * 2.5, 1.5 * (1 - blink), 0, TAU); ctx.fill();
  ctx.restore();
  put(ctx, B.wing, -6, -58, { rot: wing, lift: 0.8 });
  ctx.restore();
  // beak tip in world units (approximate under tilt)
  const bx = 34 + 52 * Math.cos(tilt) - 1 * Math.sin(tilt), by = -84 + 52 * Math.sin(tilt) + 1 * Math.cos(tilt);
  return [x + flip * s * bx / Math.sqrt(squash), y + s * by * squash];
}

// ---------- the rulebook ----------

export const BOOK = { w: 880, h: 520, pw: 418, ph: 484 };

export function buildBook() {
  const K = {};
  const { w, h, pw, ph } = BOOK;
  K.back = paper(S.rrect(w, h, 18), { color: C.coffee, seed: 21, edge: "cut", blur: 8 });
  const rules = (g, x0, x1) => {
    g.strokeStyle = "rgba(143,166,128,0.45)"; g.lineWidth = 1.6;
    for (let y = -62; y < ph / 2 - 20; y += 53) { g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y + 1.5); g.stroke(); }
  };
  K.pageL = paper(S.move(S.rrect(pw, ph, 10), -pw / 2 - 8, 0), {
    color: C.cream, seed: 22, edge: "deckle", blur: 4,
    draw(g) {
      const cx = -pw / 2 - 8;
      rules(g, -pw + 4, -40);
      ink(g, "the rulebook", cx, -ph / 2 + 96, { size: 78, color: C.coffee });
      stroke(g, wob(P.line(cx - 140, -ph / 2 + 120, cx + 140, -ph / 2 + 115), { amp: 1.6, seed: 2 }), { color: C.tomato, w: 4 });
      g.fillStyle = "rgba(60,40,24,0.10)"; g.fillRect(-26, -ph / 2, 26, ph);
    },
  });
  K.pageR = paper(S.move(S.rrect(pw, ph, 10), pw / 2 + 8, 0), {
    color: C.cream, seed: 23, edge: "deckle", blur: 4,
    draw(g) {
      const cx = pw / 2 + 8;
      ink(g, "written by you,", cx, -34, { size: 56, weight: 600, color: C.coffee, a: 0.92 });
      ink(g, "followed", cx, 36, { size: 56, weight: 600, color: C.coffee, a: 0.92 });
      ink(g, "every time", cx, 102, { size: 56, weight: 600, color: C.coffee, a: 0.92 });
      stroke(g, wob(P.bez([cx - 90, 140], [cx - 30, 156], [cx + 30, 128], [cx + 90, 142], 16), { amp: 1.2, seed: 5 }), { color: C.kraftDark, w: 3, a: 0.8 });
      g.fillStyle = "rgba(60,40,24,0.10)"; g.fillRect(0, -ph / 2, 26, ph);
    },
  });
  // Front cover, origin on the spine (its left edge), so it can be swung open.
  K.cover = paper(S.move(S.rrect(w / 2, h, 18), w / 4, 0), {
    color: C.coffee, seed: 24, edge: "cut", blur: 8,
    draw(g) {
      g.strokeStyle = C.kraft; g.lineWidth = 3;
      g.strokeRect(26, -h / 2 + 26, w / 2 - 52, h - 52);
      g.fillStyle = C.kraftDark; g.fillRect(0, -h / 2, 20, h);
      g.fillStyle = C.mustard;
      for (const [cx, cy, sx, sy] of [[w / 2, -h / 2, -1, 1], [w / 2, h / 2, -1, -1]]) { g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + sx * 62, cy); g.lineTo(cx, cy + sy * 62); g.fill(); }
    },
  });
  K.plate = paper(S.rrect(270, 150, 12), {
    color: C.cream, seed: 25, edge: "cut", blur: 3,
    draw(g) {
      ink(g, "RULES", 0, 22, { size: 82, font: FONT.print, weight: 400, color: C.coffee, bold: 2 });
      g.strokeStyle = C.tomato; g.lineWidth = 2.5; g.strokeRect(-122, -62, 244, 124);
    },
  });
  K.ribbon = paper([[-11, 0], [11, 0], [11, 96], [0, 82], [-11, 96]], { color: C.tomato, seed: 26, edge: "cut", blur: 3 });
  return K;
}

// The open (or opening) rulebook centred at (x, y). open: 0 closed .. 1 fully open.
// Closed, it sits on the right half; the cover swings round the spine to the left.
export function drawBook(ctx, K, x, y, o = {}) {
  const { open = 1, rot = 0, s = 1, lift = 1, ribbon = 0 } = o;
  const phi = clamp(open) * Math.PI, cs = Math.cos(phi);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(s, s);
  // right half: back cover and right page are there from the start
  ctx.save();
  ctx.beginPath(); ctx.rect(-6, -BOOK.h, BOOK.w, BOOK.h * 2); ctx.clip();
  put(ctx, K.back, 0, 0, { lift });
  ctx.restore();
  put(ctx, K.ribbon, 118, BOOK.h / 2 - 40, { rot: ribbon, lift: 0.6 });
  put(ctx, K.pageR, 0, 0, { lift: 0.5 });
  if (cs > 0.001) {
    // the front cover, still on the right, foreshortening as it lifts
    ctx.save(); ctx.scale(cs, 1);
    put(ctx, K.cover, 0, 0, { lift: 1 + 5 * Math.sin(phi) });
    put(ctx, K.plate, BOOK.w / 4, -20, { rot: -0.03, lift: 0.5 });
    ctx.restore();
  } else if (cs < -0.001) {
    // the cover has gone over: its inside and the left page grow out to the left
    ctx.save(); ctx.scale(-cs, 1);
    ctx.save();
    ctx.beginPath(); ctx.rect(-BOOK.w, -BOOK.h, BOOK.w + 6, BOOK.h * 2); ctx.clip();
    put(ctx, K.back, 0, 0, { lift: 1 + 5 * Math.sin(phi) });
    ctx.restore();
    put(ctx, K.pageL, 0, 0, { lift: 0.5 });
    ctx.restore();
  }
  // the gutter
  ctx.fillStyle = "rgba(44,32,25,0.55)";
  ctx.fillRect(-2, -BOOK.ph / 2 + 4, 4, BOOK.ph - 8);
  ctx.restore();
}

// The closed rulebook, front cover showing, centred at (x, y).
export function drawClosedBook(ctx, K, x, y, o = {}) {
  const { rot = 0, s = 1, lift = 1 } = o;
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
  ctx.translate(-BOOK.w / 4, 0);
  ctx.fillStyle = C.cream;
  put(ctx, K.cover, 0, 0, { lift });
  // page edges peeking out along the right and bottom
  ctx.fillRect(BOOK.w / 2 - 3, -BOOK.h / 2 + 16, 9, BOOK.h - 32);
  ctx.fillRect(22, BOOK.h / 2 - 3, BOOK.w / 2 - 34, 8);
  put(ctx, K.cover, 0, 0, { sh: 0 });
  put(ctx, K.plate, BOOK.w / 4, -20, { rot: -0.03, lift: 0.5 });
  ctx.restore();
}

// ---------- rubber stamps and their impressions ----------

export const INK = { ok: C.sageDark, adj: C.amber, no: C.tomato };

export function buildStamps() {
  const T = {};
  const body = (color, seed) => {
    const knob = paper(S.move(S.blob(27, 25, seed, 0.04), 0, -128), { color: C.kraft, seed, edge: "cut", blur: 2 });
    const neck = paper(S.move(S.rrect(26, 62, 6), 0, -84), { color: C.kraftDark, seed: seed + 1, edge: "cut", blur: 2 });
    const base = paper(S.move(S.rrect(92, 44, 12), 0, -36), { color, seed: seed + 2, edge: "cut", blur: 2 });
    const pad = paper(S.move(S.rrect(104, 16, 5), 0, -8), { color: C.coffee, seed: seed + 3, edge: "cut", blur: 2 });
    return piece(150, 190, 75, 172, (g) => {
      put(g, neck, 0, 0, { lift: 0.5 }); put(g, knob, 0, 0, { lift: 0.5 }); put(g, pad, 0, 0, { lift: 0.5 }); put(g, base, 0, 0, { lift: 0.5 });
    }, { blur: 6 });
  };
  T.ok = body(C.sageDark, 31);
  T.adj = body(C.mustard, 41);
  T.no = body(C.tomato, 51);

  const ring = (g, r, color, lw = 7) => {
    g.strokeStyle = color; g.lineWidth = lw; g.beginPath(); g.arc(0, 0, r, 0, TAU); g.stroke();
    g.lineWidth = lw * 0.3; g.beginPath(); g.arc(0, 0, r - lw * 1.35, 0, TAU); g.stroke();
  };
  T.markOk = imprint(190, 190, (g) => {
    ring(g, 80, INK.ok);
    stroke(g, wob([[-40, 2], [-12, 34], [44, -36]], { amp: 1.5, seed: 4, step: 5 }), { color: INK.ok, w: 17 });
  }, { seed: 61 });
  T.markAdj = imprint(330, 130, (g) => {
    g.strokeStyle = INK.adj; g.lineJoin = "round";
    g.lineWidth = 7; g.strokeRect(-150, -48, 300, 96);
    g.lineWidth = 2.4; g.strokeRect(-139, -37, 278, 74);
    ink(g, "ADJUSTED", 0, 22, { size: 64, font: FONT.print, weight: 400, color: INK.adj, bold: 2.4 });
  }, { seed: 62 });
  T.markNo = imprint(190, 190, (g) => {
    ring(g, 80, INK.no);
    ink(g, "NO", 0, 32, { size: 92, font: FONT.print, weight: 400, color: INK.no, bold: 4 });
  }, { seed: 63 });
  return T;
}

// ---------- a hand (the shopkeeper's), origin at the tip of the index finger ----------

export function buildHand() {
  const finger = paper(S.move(S.rrect(25, 78, 12), 0, -38), { color: C.skin, seed: 71, edge: "cut", blur: 2 });
  const thumb = paper(S.spin(S.move(S.rrect(23, 56, 11), 0, -26), 0.75), { color: C.skin, seed: 72, edge: "cut", blur: 2 });
  const palm = paper(S.move(S.blob(44, 42, 73, 0.05), -10, -104), { color: C.skin, seed: 73, edge: "cut", blur: 3 });
  const fold = paper(S.move(S.rrect(60, 34, 14), -22, -84), { color: C.skin, seed: 76, edge: "cut", blur: 2 });
  const arm = paper(S.move(S.rect(54, 150), -10, -205), { color: C.skin, seed: 74, edge: "cut", blur: 3 });
  const sleeve = paper(S.move(S.rrect(96, 620, 14), -10, -500), {
    color: C.cream, seed: 75, edge: "cut", blur: 4,
    draw(g) { g.fillStyle = C.tomato; for (let y = -820; y < -180; y += 30) g.fillRect(-70, y, 130, 12); },
  });
  return piece(240, 880, 150, 840, (g) => {
    put(g, arm, 0, 0, { lift: 0.5 }); put(g, sleeve, 0, 0, { lift: 0.7 });
    put(g, thumb, 18, -78, { lift: 0.5 }); put(g, palm, 0, 0, { lift: 0.5 }); put(g, fold, 0, 0, { lift: 0.4 }); put(g, finger, 0, 0, { lift: 0.5 });
  }, { blur: 7 });
}

// ---------- the shopkeeper (seen from the waist up, behind her counter) ----------

export function buildKeeper() {
  const Kp = {};
  const stripes = (g, x0, x1, y0, y1) => { g.fillStyle = C.tomato; for (let y = y0; y < y1; y += 24) g.fillRect(x0, y, x1 - x0, 10); };
  Kp.torso = paper(S.move(S.rrect(172, 220, 72), 0, -68), {
    color: C.cream, seed: 81, edge: "cut",
    draw(g) {
      stripes(g, -100, 100, -176, 50);
      g.fillStyle = C.sageDark; // apron straps
      g.beginPath(); g.moveTo(-44, -120); g.lineTo(-30, -120); g.lineTo(-40, -180); g.lineTo(-56, -180); g.fill();
      g.beginPath(); g.moveTo(44, -120); g.lineTo(30, -120); g.lineTo(40, -180); g.lineTo(56, -180); g.fill();
    },
  });
  const pocket = wob([[-26, -34], [-26, 0], [26, 0], [26, -34]], { amp: 1, seed: 8 });
  Kp.apron = paper([[-50, -124], [50, -124], [58, -64], [84, 46], [-84, 46], [-58, -64]], {
    color: C.sage, seed: 82, edge: "cut", blur: 3,
    draw(g) { stroke(g, pocket, { color: C.sageDark, w: 2.6 }); stroke(g, wob(P.line(-26, -34, 26, -34), { amp: 1, seed: 9 }), { color: C.sageDark, w: 2.6 }); },
  });
  Kp.neck = paper(S.move(S.rrect(40, 44, 10), 0, -186), { color: C.skin, seed: 83, edge: "cut", blur: 2 });
  // head pieces: origin at the centre of the face
  Kp.hairBack = paper(S.blob(74, 76, 84, 0.05), { color: C.coffee, seed: 84, edge: "cut" });
  Kp.bun = paper(S.blob(31, 27, 85, 0.06), { color: C.coffee, seed: 85, edge: "cut", blur: 3 });
  Kp.face = paper(S.move(S.blob(58, 61, 86, 0.025), 0, 4), { color: C.skin, seed: 86, edge: "cut", blur: 3 });
  const top = Array.from({ length: 19 }, (_, i) => { const a = Math.PI * (1.04 + (0.92 * i) / 18); return [Math.cos(a) * 62, 2 + Math.sin(a) * 66]; });
  Kp.fringe = paper([...top, [50, -22], [22, -38], [-12, -36], [-40, -18], [-58, 2]], { color: C.coffee, seed: 87, edge: "cut", blur: 2.5 });
  Kp.clip = paper(S.spin(S.rrect(26, 9, 4), -0.5), { color: C.mustard, seed: 88, edge: "cut", blur: 1.5 });
  // arms: origin at the top of each bone
  Kp.upper = paper(S.move(S.rrect(42, 112, 21), 0, 46), { color: C.cream, seed: 89, edge: "cut", blur: 3, draw(g) { stripes(g, -30, 30, -8, 110); } });
  Kp.fore = paper(S.move(S.rrect(29, 104, 14), 0, 46), { color: C.skin, seed: 90, edge: "cut", blur: 3 });
  Kp.hand = paper(S.blob(21, 19, 91, 0.05), { color: C.skin, seed: 91, edge: "cut", blur: 2.5 });
  Kp.drop = paper([[0, -15], [8, 0], [0, 9], [-8, 0]].map(([x, y]) => [x, y]), { color: C.white, seed: 92, edge: "cut", blur: 2 });
  return Kp;
}

const BONE = 100;

// Draws her standing with her waist at (x, y). pose:
//   lHand, rHand  [x, y] hand targets in the same coordinates as (x, y)
//   look [dx, dy] (-1..1), blink, worry (0..1), smile (0..1), tilt (head, radians), bob (px)
//   part: "body", "arms" or undefined for both (so the counter can go between them)
export function drawKeeper(ctx, Kp, x, y, pose = {}) {
  const { look = [0, 0], blink = 0, worry = 0, smile = 0.6, tilt = 0, bob = 0, lHand = [x - 80, y - 20], rHand = [x + 80, y - 20], hold = null, part = null } = pose;
  if (part !== "arms") drawKeeperBody(ctx, Kp, x, y, { look, blink, worry, smile, tilt, bob });
  if (part === "body") return;
  // arms (in world coordinates, so the hands can go to things)
  const arm = (side, target) => {
    const sx = x + side * 66, sy = y + bob - 150;
    const e = elbow(sx, sy, target[0], target[1], BONE, BONE, -side);
    put(ctx, Kp.upper, sx, sy, { rot: Math.atan2(e.ey - sy, e.ex - sx) - Math.PI / 2, lift: 0.7 });
    put(ctx, Kp.fore, e.ex, e.ey, { rot: Math.atan2(e.hy - e.ey, e.hx - e.ex) - Math.PI / 2, lift: 0.7 });
    return e;
  };
  const l = arm(-1, lHand), r = arm(1, rHand);
  if (hold) hold(l, r);
  put(ctx, Kp.hand, l.hx, l.hy, { lift: 0.6 });
  put(ctx, Kp.hand, r.hx, r.hy, { lift: 0.6 });
}

function drawKeeperBody(ctx, Kp, x, y, { look, blink, worry, smile, tilt, bob }) {
  ctx.save();
  ctx.translate(x, y + bob);
  put(ctx, Kp.neck, 0, 0);
  put(ctx, Kp.torso, 0, 0);
  put(ctx, Kp.apron, 0, 0, { lift: 0.6 });
  // head
  ctx.save();
  ctx.translate(0, -238);
  ctx.rotate(tilt);
  put(ctx, Kp.hairBack, 0, -6);
  put(ctx, Kp.bun, 20, -78, { lift: 0.6 });
  put(ctx, Kp.face, 0, 0, { lift: 0.6 });
  put(ctx, Kp.fringe, 0, 0, { lift: 0.5 });
  put(ctx, Kp.clip, 42, -30, { lift: 0.4 });
  // cheeks
  ctx.fillStyle = "rgba(214,73,47,0.2)";
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(sx * 37, 22, 12, 9, 0, 0, TAU); ctx.fill(); }
  // eyes
  ctx.fillStyle = C.ink;
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(sx * 22 + look[0] * 4, 4 + look[1] * 3, 5, 6.4 * (1 - 0.92 * blink) + 0.4, 0, 0, TAU); ctx.fill(); }
  // brows
  ctx.strokeStyle = C.coffee; ctx.lineWidth = 3.2; ctx.lineCap = "round";
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.moveTo(sx * 33, -15 + 4 * worry); ctx.lineTo(sx * 13, -17 - 7 * worry); ctx.stroke(); }
  // mouth
  ctx.lineWidth = 3.2;
  const mw = 14 - 5 * worry;
  ctx.beginPath(); ctx.moveTo(-mw, 30 + 2 * worry); ctx.quadraticCurveTo(0, 30 + 13 * smile * (1 - worry) - 5 * worry, mw, 30 + 2 * worry); ctx.stroke();
  ctx.restore();
  ctx.restore();
}

// ---------- small shared props ----------

export function buildProps() {
  const R = {};
  R.tapeA = tape(120, 34, 1);
  R.tapeB = tape(96, 30, 2);
  R.tapeC = tape(150, 38, 3);
  return R;
}

export { label };
