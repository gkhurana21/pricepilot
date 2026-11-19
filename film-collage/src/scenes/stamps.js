// Scene 5. "Every suggestion is accepted, adjusted, or refused. And every refusal names its rule."
// Three tags on a line, three rubber stamps. Each verdict lands on its word, and a slip under each tag
// says which rule spoke. The prices are the ones from the development-store run (see README.md).

import { C, FONT, S, paper, put, ink, label, wob, stroke, P } from "../lib/paper.js";
import { E, prog, spring, swing, settle, lerp, TAU } from "../lib/util.js";
import { makeTag, hangTag } from "../cast.js";
import { camera, track } from "./common.js";

const XS = [430, 960, 1490];
const KEYS = ["ok", "adj", "no"];
const LAY = { name: 0.29, mid: 0.44, price: 0.655 };
const MARK = [[66, 356], [14, 362], [66, 356]];     // where each impression sits, from the tag's hole
const REST_Y = 992;

export function events(tl) {
  const T = ["accepted", "adjusted", "refused"].map((w) => tl.word("05a", w) + 0.12);
  return { T, names: tl.word("05b", "names"), b: tl.p("05b").start, end: tl.p("05b").end };
}

export function cues(tl, scene) {
  const e = events(tl);
  return [
    { t: scene.start + 0.1, s: "slide", g: 0.7 },
    ...e.T.flatMap((t) => [{ t: t - 0.5, s: "whoosh", g: 0.3 }, { t, s: "stamp", g: 0.9 }, { t: t + 0.42, s: "paper", g: 0.4 }]),
    { t: e.names - 0.05, s: "scratch", g: 0.55, d: 0.5 },
  ];
}

export function build(A, tl, scene) {
  const s = { e: events(tl), T: A.stamps, start: scene.start };
  s.tags = [
    makeTag({ w: 330, h: 480, name: "Brazil", was: "$19.00", price: "$17.99", seed: 501, lay: LAY, priceSize: 104, nameSize: 66 }),
    makeTag({ w: 330, h: 480, name: "Kenya", was: "$20.00", price: "$18.99", seed: 502, lay: LAY, priceSize: 104, nameSize: 66 }),
    makeTag({ w: 330, h: 480, name: "Subscription", small: "stays", price: "$28.00", seed: 503, lay: LAY, priceSize: 104, nameSize: 54 }),
  ];
  s.marks = [A.stamps.markOk, A.stamps.markAdj, A.stamps.markNo];
  const slip = (text, seed, color = C.cream) => paper(S.rect(text.length * 21 + 70, 76), {
    color, seed, edge: "deckle",
    draw(g) { ink(g, text, 0, 17, { size: 54, color: C.coffee }); },
  });
  s.slips = [slip("every rule passed", 511), slip("margin floor", 512), slip("excluded by policy", 513)];
  s.ring = wob(P.arc(0, 0, 232, 58, -Math.PI * 0.62, Math.PI * 1.5, 60), { amp: 2.2, seed: 514, step: 6 });
  s.pad = paper(S.rrect(1500, 46, 12), { color: C.coffee, seed: 515, edge: "cut", res: 1 });
  s.clip = paper(S.rrect(20, 56, 5), { color: C.kraft, seed: 516, blur: 2 });
  s.band = paper([[-1150, 0], [1150, 0], [1150, 260], [-1150, 260]], { color: C.sagePale, edge: "torn", seed: 517, res: 1, amp: 4.5 });
  s.tape = A.props.tapeB;
  return s;
}

const sag = (x) => { const u = (x + 40) / 2000; return 104 + 2 * u * (1 - u) * 184; };   // the hanging line's height at x

export function draw(ctx, t, s) {
  const e = s.e;
  ctx.save();
  camera(ctx, 960, 540 - 6 * prog(t, s.start, e.end + 1), 1.005 + 0.02 * E.inOutSine(prog(t, s.start, e.end + 1.2)));

  put(ctx, s.band, 960, 846, { lift: 0.7 });
  put(ctx, s.pad, 960, REST_Y + 8, { lift: 0.8 });

  // the line the tags hang on
  ctx.strokeStyle = C.coffee; ctx.lineWidth = 3; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(-40, 104); ctx.quadraticCurveTo(960, 288, 1960, 104); ctx.stroke();

  const sway0 = (i) => settle(t - (s.start + 0.5 + i * 0.07), 0.07 * (i === 1 ? -1 : 1), 0.9, 1.1) * prog(t, s.start + 0.3, s.start + 0.6);
  XS.forEach((x, i) => {
    const T = e.T[i], y0 = sag(x);
    const jolt = swing(t - T, 0.035, 2.4, 3.2);
    const th = sway0(i) + jolt + 0.008 * Math.sin(t * 1.1 + i * 2);

    // the slip that names the rule: tucked behind the tag, slid out after the stamp
    const sl = spring(t - (T + 0.4), 1.8, 0.6);
    if (sl > 0) {
      const sy = y0 + 300 + 250 * sl;
      put(ctx, s.slips[i], x + (i - 1) * 6, sy, { rot: [-0.03, 0.025, -0.02][i] + 0.1 * (1 - Math.min(1, sl)), lift: 0.8 });
      put(ctx, s.tape, x + (i - 1) * 6 - s.slips[i].w / 2 + 34, sy - 26, { rot: -0.5, a: prog(t, T + 0.75, T + 0.8), s: 1 + 0.5 * (1 - E.out(prog(t, T + 0.75, T + 0.95))), lift: 0.5 });
      if (i === 2) {
        // "names its rule": pencilled round
        ctx.save(); ctx.translate(x + 6, sy + 1); ctx.rotate(-0.03);
        stroke(ctx, s.ring, { color: C.tomato, w: 5, to: E.inOut(prog(t, e.names - 0.05, e.names + 0.55)) });
        ctx.restore();
      }
    }

    // the tag, and its verdict once the stamp has been down
    put(ctx, s.clip, x, y0 - 4, { lift: 0.5 });
    const [hx, hy] = hangTag(ctx, s.tags[i], x, y0, 30, th, { lift: 1.3, sw: 3 });
    if (t >= T) {
      ctx.save(); ctx.translate(hx, hy); ctx.rotate(-th * 1.15);
      put(ctx, s.marks[i], MARK[i][0], MARK[i][1], { rot: [-0.2, -0.1, 0.16][i], s: i === 1 ? 0.92 : 0.86 });
      ctx.restore();
    }
    if (i === 1) track(ctx, "stamps:tag", hx, hy);
  });

  // the stamps: up from their pad, over the tag, down, and back
  XS.forEach((x, i) => {
    const T = e.T[i], y0 = sag(x) + 30;
    const m = E.inOut(prog(t, T - 0.64, T - 0.16)) - E.inOut(prog(t, T + 0.16, T + 0.86));
    const press = E.in(prog(t, T - 0.15, T)) - E.out(prog(t, T + 0.1, T + 0.34));
    const tx = x + MARK[i][0], ty = y0 + MARK[i][1] + 74;
    const px = lerp(x, tx, m), py = lerp(REST_Y, ty, m) - 50 * Math.sin(Math.PI * Math.min(1, Math.max(0, m)));
    put(ctx, s.T[KEYS[i]], px, py, { rot: -0.22 * m + 0.1 * press, s: 1 + 0.42 * m - 0.24 * press, lift: 1 + 9 * m - 8.6 * press });
    track(ctx, "stamps:stamp" + i, px, py);
  });
  ctx.restore();
}
