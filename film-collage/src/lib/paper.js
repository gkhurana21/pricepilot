// Paper: every piece in the film is cut once into an offscreen canvas (shape, grain, edge, drop shadow)
// and then only moved, rotated and layered. Nothing here runs per frame except put() and stroke().
// All randomness is seeded, so the grain and every edge are identical on every frame and every run.

import { mulberry, fbm1, hash, TAU } from "./util.js";

export const RES = 1.5; // sprite pixels per film pixel, so pieces stay crisp when the camera moves in

export const C = {
  cream: "#f4ecd9",
  page: "#efe5cd",
  pageWarm: "#ead9b8",
  white: "#fbf7ec",
  kraft: "#c79f72",
  kraftLight: "#dcbd94",
  kraftDark: "#a67d52",
  coffee: "#4b3425",
  ink: "#2c2019",
  tomato: "#d6492f",
  tomatoDark: "#b53a24",
  sage: "#8fa680",
  sageDark: "#587550",
  sagePale: "#c5d0b0",
  mustard: "#e2a92f",
  mustardPale: "#f1dc9c",
  amber: "#c07d12",
  skin: "#e9c19d",
  shadow: "rgb(58,38,24)",
};

export const FONT = { hand: "Caveat", print: "Patrick Hand" };

export function mk(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

// ---------- textures (built once) ----------

let _grain = null, _erase = null;

function grainTile() {
  if (_grain) return _grain;
  const N = 512, c = mk(N, N), g = c.getContext("2d"), r = mulberry(4711);
  const wrap = (fn) => { for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) { g.save(); g.translate(dx, dy); fn(); g.restore(); } };
  // soft mottling
  for (let i = 0; i < 26; i++) {
    const x = r() * N, y = r() * N, rad = 30 + r() * 70, dark = r() < 0.55;
    g.filter = "blur(18px)";
    g.fillStyle = dark ? `rgba(70,48,28,${0.035 + r() * 0.03})` : `rgba(255,252,240,${0.05 + r() * 0.04})`;
    wrap(() => { g.beginPath(); g.ellipse(x, y, rad, rad * (0.5 + r() * 0.5), r() * 3, 0, TAU); g.fill(); });
  }
  g.filter = "none";
  // fibres
  g.lineCap = "round";
  for (let i = 0; i < 900; i++) {
    const x = r() * N, y = r() * N, a = r() * TAU, len = 5 + r() * 20, bend = (r() - 0.5) * 8, dark = r() < 0.5;
    g.strokeStyle = dark ? `rgba(64,42,24,${0.05 + r() * 0.08})` : `rgba(255,253,244,${0.08 + r() * 0.12})`;
    g.lineWidth = 0.5 + r() * 0.7;
    const x1 = x + Math.cos(a) * len, y1 = y + Math.sin(a) * len;
    wrap(() => { g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo((x + x1) / 2 + bend, (y + y1) / 2 - bend, x1, y1); g.stroke(); });
  }
  // specks
  for (let i = 0; i < 9000; i++) {
    const x = r() * N, y = r() * N, s = 0.6 + r() * 1.1, dark = r() < 0.6;
    g.fillStyle = dark ? `rgba(60,40,24,${0.03 + r() * 0.07})` : `rgba(255,253,244,${0.05 + r() * 0.1})`;
    g.fillRect(x, y, s, s);
  }
  return (_grain = c);
}

// Speckle used to break up pencil and stamp ink (drawn with destination-out).
function eraseTile() {
  if (_erase) return _erase;
  const N = 256, c = mk(N, N), g = c.getContext("2d"), r = mulberry(99);
  for (let i = 0; i < 5200; i++) {
    g.fillStyle = `rgba(0,0,0,${0.15 + r() * 0.6})`;
    const s = 0.6 + r() * 1.6;
    g.fillRect(r() * N, r() * N, s, s * (0.6 + r()));
  }
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(0,0,0,${0.2 + r() * 0.5})`;
    g.beginPath(); g.ellipse(r() * N, r() * N, 1.5 + r() * 4, 1 + r() * 2.5, r() * 3, 0, TAU); g.fill();
  }
  return (_erase = c);
}

function distress(g, w, h, amount, seed = 1) {
  if (amount <= 0) return;
  const r = mulberry(seed);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = "destination-out";
  g.globalAlpha = amount;
  g.translate(-r() * 200, -r() * 200);
  g.fillStyle = g.createPattern(eraseTile(), "repeat");
  g.fillRect(0, 0, w + 256, h + 256);
  g.restore();
}

// ---------- outlines ----------

export const S = {
  rect: (w, h) => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]],
  rrect(w, h, rad, n = 6) {
    const r = Math.min(rad, w / 2, h / 2), p = [];
    const corner = (cx, cy, a0) => { for (let i = 0; i <= n; i++) { const a = a0 + (i / n) * (Math.PI / 2); p.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
    corner(w / 2 - r, -h / 2 + r, -Math.PI / 2);
    corner(w / 2 - r, h / 2 - r, 0);
    corner(-w / 2 + r, h / 2 - r, Math.PI / 2);
    corner(-w / 2 + r, -h / 2 + r, Math.PI);
    return p;
  },
  ellipse(rx, ry, n = 44) {
    return Array.from({ length: n }, (_, i) => { const a = (i / n) * TAU; return [Math.cos(a) * rx, Math.sin(a) * ry]; });
  },
  // An organic rounded lump: an ellipse whose radius wanders.
  blob(rx, ry, seed, wob = 0.1, n = 40) {
    const f = fbm1(seed, 2);
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * TAU, w = i / n;
      const k = 1 + wob * (f(i * 0.35) * (1 - w) + f((i - n) * 0.35) * w);
      return [Math.cos(a) * rx * k, Math.sin(a) * ry * k];
    });
  },
  // A price tag: a rectangle with the two top corners snipped off. Origin at the punched hole.
  tag(w, h, snip = 0.2, holeY = 0.13) {
    const s = w * snip, top = -h * holeY;
    return [[-w / 2 + s, top], [w / 2 - s, top], [w / 2, top + s], [w / 2, top + h], [-w / 2, top + h], [-w / 2, top + s]];
  },
  move: (pts, dx, dy) => pts.map(([x, y]) => [x + dx, y + dy]),
  spin: (pts, a) => pts.map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]),
  scale: (pts, sx, sy = sx) => pts.map(([x, y]) => [x * sx, y * sy]),
};

// Resample a closed outline and push it in and out along its normal with seeded noise.
// Sharp corners stay where they are; the noise wraps so the outline closes without a seam.
export function roughen(pts, { amp = 1, step = 5, seed = 1, fine = 0.4, wave = 60, bias = 0 } = {}) {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const sign = area > 0 ? 1 : -1; // outward normal for either winding
  const sharp = pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const ux = p[0] - a[0], uy = p[1] - a[1], vx = b[0] - p[0], vy = b[1] - p[1];
    const d = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return Math.abs(d) > 0.5;
  });
  const sm = [];
  let L = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.round(len / step));
    for (let j = 0; j < k; j++) {
      const u = j / k;
      sm.push({ x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, s: L + len * u, corner: j === 0 && sharp[i] });
    }
    L += len;
  }
  const m = sm.length;
  // distance along the outline to the nearest sharp corner
  const corners = sm.filter((p) => p.corner).map((p) => p.s);
  const dist = sm.map((p) => {
    let d = Infinity;
    for (const c of corners) { const k = Math.abs(p.s - c); d = Math.min(d, k, L - k); }
    return d;
  });
  const lo = fbm1(seed, 2), hi = fbm1(seed + 7, 2);
  const f = (s) => lo(s / wave) + fine * hi(s / 6.5);
  const out = [];
  for (let i = 0; i < m; i++) {
    const p = sm[i], a = sm[(i - 1 + m) % m], b = sm[(i + 1) % m];
    let tx = b.x - a.x, ty = b.y - a.y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const w = p.s / L;
    const taper = Math.min(1, dist[i] / (step * 2.2));
    const d = (amp * (f(p.s) * (1 - w) + f(p.s - L) * w) + bias) * taper;
    out.push([p.x + ty * sign * d, p.y - tx * sign * d]);
  }
  return out;
}

function trace(g, pts) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
}

// ---------- a piece of paper ----------

// pts: closed outline in local units, around the piece's anchor (0,0).
// edge: "cut" (scissors), "torn" (ragged, with the white core showing), "deckle" (soft), "clean".
// draw(g): optional marks made on the paper before the grain goes on, clipped to the piece.
export function paper(pts, o = {}) {
  const { color = C.cream, edge = "cut", seed = 1, grain = 1, res = RES, shadow = true, holes = [], draw = null, pad = 12, blur = 5, coreColor = C.white } = o;
  let outline = pts, core = null;
  if (edge === "cut") outline = roughen(pts, { amp: o.amp ?? 0.9, step: 9, seed, fine: 0.12, wave: 95 });
  else if (edge === "deckle") outline = roughen(pts, { amp: o.amp ?? 1.5, step: 3, seed, fine: 1.0, wave: 50 });
  else if (edge === "torn") {
    outline = roughen(pts, { amp: o.amp ?? 3.2, step: 3.2, seed, fine: 0.75, wave: 34 });
    core = roughen(pts, { amp: (o.amp ?? 3.2) * 1.15, step: 3.2, seed: seed + 31, fine: 0.9, wave: 26, bias: o.bias ?? 2.2 });
  }
  const all = core ? outline.concat(core) : outline;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of all) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  x0 = Math.floor(x0 - pad); y0 = Math.floor(y0 - pad);
  const w = Math.ceil(x1 + pad) - x0, h = Math.ceil(y1 + pad) - y0;
  const c = mk(w * res, h * res), g = c.getContext("2d");
  g.scale(res, res);
  g.translate(-x0, -y0);
  if (core) { trace(g, core); g.fillStyle = coreColor; g.fill(); }
  trace(g, outline);
  g.fillStyle = color;
  g.fill();
  if (draw) { g.save(); trace(g, outline); g.clip(); draw(g); g.restore(); }
  // grain, only where there is paper
  if (grain > 0) {
    const r = mulberry(seed * 13 + 5);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "source-atop";
    g.globalAlpha = Math.min(1, grain);
    g.translate(-r() * 512, -r() * 512);
    g.fillStyle = g.createPattern(grainTile(), "repeat");
    g.fillRect(0, 0, c.width + 512, c.height + 512);
    g.restore();
  }
  // the cut edge catches a little shade (not on pieces that are tiled edge to edge)
  if (o.edgeShade !== false) {
  g.save();
  g.globalCompositeOperation = "source-atop";
  trace(g, outline);
  g.strokeStyle = "rgba(70,46,26,0.13)";
  g.lineWidth = 2.2;
  g.stroke();
  g.restore();
  }
  if (holes.length) {
    g.save();
    g.globalCompositeOperation = "destination-out";
    for (const hh of holes) { g.beginPath(); g.arc(hh.x, hh.y, hh.r, 0, TAU); g.fill(); }
    g.restore();
  }
  if (o.over) o.over(g);
  return finish(c, x0, y0, w, h, res, shadow, blur);
}

function finish(c, x0, y0, w, h, res, shadow, blur) {
  let s = null;
  if (shadow) {
    s = mk(c.width, c.height);
    const sg = s.getContext("2d");
    sg.filter = `blur(${blur * res}px)`;
    sg.drawImage(c, 0, 0);
    sg.filter = "none";
    sg.globalCompositeOperation = "source-in";
    sg.fillStyle = C.shadow;
    sg.fillRect(0, 0, s.width, s.height);
  }
  return { c, s, ox: x0, oy: y0, w, h, res };
}

// Wrap an already-drawn canvas (local units w x h, anchor at ax, ay) as a piece with a shadow.
export function piece(w, h, ax, ay, drawFn, { res = RES, shadow = true, blur = 5 } = {}) {
  const c = mk(w * res, h * res), g = c.getContext("2d");
  g.scale(res, res);
  g.translate(ax, ay);
  drawFn(g);
  return finish(c, -ax, -ay, w, h, res, shadow, blur);
}

// Lay a piece down. Position, rotation and scale are sub-pixel; the shadow slides further out and
// fades a little as `lift` grows, which is what makes a piece look raised off the page.
export function put(ctx, sp, x, y, o = {}) {
  const { rot = 0, s = 1, sx = s, sy = s, a = 1, lift = 1, sh = 1 } = o;
  if (a <= 0.001) return;
  if (sp.s && sh > 0 && lift > 0) {
    ctx.save();
    ctx.globalAlpha *= a * sh * 0.34 / (1 + 0.1 * Math.max(0, lift - 1));
    ctx.translate(x + 2.6 * lift, y + 4.2 * lift);
    ctx.rotate(rot);
    ctx.scale(sx, sy);
    ctx.drawImage(sp.s, sp.ox, sp.oy, sp.w, sp.h);
    ctx.restore();
  }
  ctx.save();
  ctx.globalAlpha *= a;
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(sx, sy);
  ctx.drawImage(sp.c, sp.ox, sp.oy, sp.w, sp.h);
  ctx.restore();
}

// ---------- lettering ----------

const fontOf = (o) => `${o.weight ?? 700} ${o.size}px "${o.font ?? FONT.hand}"`;

// Draw lettering straight onto a piece (inside a paper() draw callback).
export function ink(g, str, x, y, o = {}) {
  const { size = 40, color = C.ink, align = "center", bold = 0, a = 1 } = o;
  g.save();
  g.font = fontOf({ ...o, size });
  g.textAlign = align;
  g.textBaseline = "alphabetic";
  g.globalAlpha *= a;
  g.fillStyle = color;
  if (bold > 0) { g.strokeStyle = color; g.lineWidth = bold; g.lineJoin = "round"; g.strokeText(str, x, y); }
  g.fillText(str, x, y);
  g.restore();
}

const _labels = new Map();
// A line of lettering as its own piece (no shadow). Anchor: horizontally by `align`, vertically on
// the middle of the lower-case letters. pencil (0..1) breaks the stroke up like graphite.
export function label(str, o = {}) {
  const key = JSON.stringify([str, o]);
  if (_labels.has(key)) return _labels.get(key);
  const { size = 48, color = C.ink, align = "center", bold = 0, pencil = 0, res = RES } = o;
  const probe = mk(4, 4).getContext("2d");
  probe.font = fontOf({ ...o, size });
  const m = probe.measureText(str);
  const pad = 6 + bold;
  const left = Math.max(m.actualBoundingBoxLeft, 0) + pad, right = Math.max(m.actualBoundingBoxRight, m.width) + pad;
  const asc = m.actualBoundingBoxAscent + pad, desc = m.actualBoundingBoxDescent + pad;
  const w = left + right, h = asc + desc;
  const ax = align === "center" ? left + m.width / 2 : align === "right" ? left + m.width : left;
  const ay = asc - size * 0.27;
  const c = mk(w * res, h * res), g = c.getContext("2d");
  g.scale(res, res);
  ink(g, str, left, asc, { ...o, size, color, align: "left", bold });
  distress(g, c.width, c.height, pencil, hash(str));
  const sp = { c, s: null, ox: -ax, oy: -ay, w, h, res, tw: m.width };
  _labels.set(key, sp);
  return sp;
}

// Letters cut out of coloured paper: each glyph fattened (so it reads as a cut shape, not type),
// tipped a little, given grain and a shadow.
export function cutout(str, o = {}) {
  const { size = 200, color = C.tomato, seed = 1, jitter = 1, res = RES, gap = 0, grain = 1, blur = 6 } = o;
  const fat = o.fat ?? size * 0.03;
  const probe = mk(4, 4).getContext("2d");
  probe.font = fontOf({ ...o, size });
  const r = mulberry(seed);
  const glyphs = [];
  let x = 0;
  for (const ch of str) {
    const adv = probe.measureText(ch).width;
    glyphs.push({ ch, x: x + adv / 2, rot: (r() - 0.5) * 0.09 * jitter, dy: (r() - 0.5) * size * 0.05 * jitter });
    x += adv + gap + fat * 0.6;
  }
  const tw = x - gap - fat * 0.6, pad = 24 + fat;
  const w = tw + pad * 2, h = size * 1.25 + pad * 2;
  const ax = pad + tw / 2, ay = pad + size * 0.62;
  const c = mk(w * res, h * res), g = c.getContext("2d");
  g.scale(res, res);
  g.font = fontOf({ ...o, size });
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  g.fillStyle = color;
  g.strokeStyle = color;
  g.lineJoin = "round";
  g.lineWidth = fat * 2;
  for (const gl of glyphs) {
    g.save();
    g.translate(pad + gl.x, pad + size * 0.92 + gl.dy);
    g.rotate(gl.rot);
    g.strokeText(gl.ch, 0, 0);
    g.fillText(gl.ch, 0, 0);
    g.restore();
  }
  if (grain > 0) {
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "source-atop";
    g.globalAlpha = grain;
    g.translate(-r() * 512, -r() * 512);
    g.fillStyle = g.createPattern(grainTile(), "repeat");
    g.fillRect(0, 0, c.width + 512, c.height + 512);
    g.restore();
  }
  const sp = finish(c, -ax, -ay, w, h, res, true, blur);
  sp.tw = tw;
  return sp;
}

// A strip of masking tape: translucent, with pinked ends.
export function tape(w = 120, h = 34, seed = 1, color = "rgba(233,214,160,0.84)") {
  const r = mulberry(seed), teeth = 5, pts = [];
  pts.push([-w / 2, -h / 2]);
  pts.push([w / 2, -h / 2]);
  for (let i = 0; i < teeth; i++) { pts.push([w / 2 + 4 + r() * 2, -h / 2 + ((i + 0.5) / teeth) * h]); pts.push([w / 2, -h / 2 + ((i + 1) / teeth) * h]); }
  pts.push([-w / 2, h / 2]);
  for (let i = teeth - 1; i >= 0; i--) { pts.push([-w / 2 - 4 - r() * 2, -h / 2 + ((i + 0.5) / teeth) * h]); pts.push([-w / 2, -h / 2 + (i / teeth) * h]); }
  return paper(pts, {
    color, edge: "clean", seed, grain: 0.7, blur: 3, pad: 10,
    draw(g) {
      g.strokeStyle = "rgba(255,250,230,0.25)";
      g.lineWidth = 1;
      for (let i = 0; i < 5; i++) { const y = -h / 2 + r() * h; g.beginPath(); g.moveTo(-w / 2, y); g.lineTo(w / 2, y + (r() - 0.5) * 3); g.stroke(); }
    },
  });
}

// ---------- pencil lines (the only thing drawn fresh each frame) ----------

export const P = {
  line: (x0, y0, x1, y1) => [[x0, y0], [x1, y1]],
  bez(p0, p1, p2, p3, n = 28) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      out.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
    }
    return out;
  },
  arc(cx, cy, rx, ry, a0, a1, n = 36) {
    return Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]; });
  },
};

// Give an open path a hand: resample it and let it wander a little. Returns points with arc lengths.
export function wob(pts, { amp = 1.3, step = 6, seed = 1, wave = 46 } = {}) {
  const nx = fbm1(seed, 2), ny = fbm1(seed + 3, 2);
  const out = [];
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.round(len / step));
    for (let j = 0; j < k + (i === pts.length - 2 ? 1 : 0); j++) {
      const u = j / k, d = s + len * u;
      out.push([a[0] + (b[0] - a[0]) * u + amp * nx(d / wave), a[1] + (b[1] - a[1]) * u + amp * ny(d / wave)]);
    }
    s += len;
  }
  const len = [0];
  for (let i = 1; i < out.length; i++) len.push(len[i - 1] + Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));
  out.len = len;
  out.total = len[len.length - 1];
  return out;
}

// Stroke part of a wob() path, from fraction `from` to fraction `to` of its length (for drawing on).
export function stroke(ctx, W, o = {}) {
  const { color = C.ink, w = 3, a = 1, from = 0, to = 1, dash = null } = o;
  if (to - from < 0.004 || a <= 0) return;
  const s0 = from * W.total, s1 = to * W.total;
  ctx.save();
  ctx.globalAlpha *= a;
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < W.length - 1; i++) {
    const a0 = W.len[i], a1 = W.len[i + 1];
    if (a1 < s0 || a0 > s1) continue;
    const seg = a1 - a0 || 1;
    const u0 = Math.max(0, (s0 - a0) / seg), u1 = Math.min(1, (s1 - a0) / seg);
    const p = W[i], q = W[i + 1];
    if (!started) { ctx.moveTo(p[0] + (q[0] - p[0]) * u0, p[1] + (q[1] - p[1]) * u0); started = true; }
    ctx.lineTo(p[0] + (q[0] - p[0]) * u1, p[1] + (q[1] - p[1]) * u1);
  }
  ctx.stroke();
  ctx.restore();
}

// Point at a fraction along a wob() path (for a pencil tip that follows the line it is drawing).
export function along(W, f) {
  const s = Math.min(1, Math.max(0, f)) * W.total;
  for (let i = 0; i < W.length - 1; i++) {
    if (W.len[i + 1] >= s) {
      const u = (s - W.len[i]) / (W.len[i + 1] - W.len[i] || 1);
      return [W[i][0] + (W[i + 1][0] - W[i][0]) * u, W[i][1] + (W[i + 1][1] - W[i][1]) * u];
    }
  }
  return W[W.length - 1];
}

// Pencil marks baked into a piece: a set of wob() paths stroked with a graphite break-up.
export function sketch(w, h, ax, ay, drawFn, { res = RES, pencil = 0.35, seed = 1 } = {}) {
  const c = mk(w * res, h * res), g = c.getContext("2d");
  g.scale(res, res);
  g.translate(ax, ay);
  drawFn(g);
  distress(g, c.width, c.height, pencil, seed);
  return { c, s: null, ox: -ax, oy: -ay, w, h, res };
}

// A rubber-stamp impression: ink that did not quite take everywhere.
export function imprint(w, h, drawFn, { res = RES, wear = 0.55, seed = 1 } = {}) {
  const c = mk(w * res, h * res), g = c.getContext("2d");
  g.scale(res, res);
  g.translate(w / 2, h / 2);
  drawFn(g);
  distress(g, c.width, c.height, wear, seed);
  return { c, s: null, ox: -w / 2, oy: -h / 2, w, h, res };
}

// A full sheet to build a scene on: bigger than the frame so it can drift and slide.
export function sheet(color, seed, w = 2120, h = 1240) {
  const r = mulberry(seed);
  return paper(S.rect(w, h), {
    color, edge: "cut", seed, grain: 1, res: 1, pad: 26, blur: 12,
    draw(g) {
      g.filter = "blur(70px)";
      for (let i = 0; i < 16; i++) {
        g.fillStyle = r() < 0.5 ? `rgba(120,86,48,${0.03 + r() * 0.03})` : `rgba(255,252,238,${0.06 + r() * 0.05})`;
        g.beginPath();
        g.ellipse((r() - 0.5) * w, (r() - 0.5) * h, 160 + r() * 320, 120 + r() * 220, r() * 3, 0, TAU);
        g.fill();
      }
      g.filter = "none";
    },
  });
}
