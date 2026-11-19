// The film. boot() cuts all the paper once; renderAt(t) lays it out for time t (seconds).
// renderAt is deterministic: the same t always draws the same frame, whatever was drawn before.

import { buildTimeline, checkTimeline, W, H, FPS } from "./timeline.js";
import { C, sheet, put } from "./lib/paper.js";
import { E, prog } from "./lib/util.js";
import { buildBird, buildBook, buildStamps, buildHand, buildKeeper, buildProps } from "./cast.js";
import * as lever from "./scenes/lever.js";
import * as stall from "./scenes/stall.js";
import * as stamps from "./scenes/stamps.js";
import * as apply from "./scenes/apply.js";
import * as scroll from "./scenes/scroll.js";
import * as card from "./scenes/card.js";

const MODS = { lever, stall, stamps, apply, scroll, card };
const SHEETS = { lever: [C.page, 101], stall: [C.cream, 102], stamps: [C.pageWarm, 103], apply: [C.page, 104], scroll: [C.pageWarm, 105], card: [C.cream, 106] };

let ctx, tl, A, desk;
const state = {};

async function loadImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

export async function boot(canvas) {
  canvas.width = W;
  canvas.height = H;
  ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const fonts = [
    new FontFace("Caveat", "url(assets/fonts/Caveat-Variable.ttf)", { weight: "400 700" }),
    new FontFace("Patrick Hand", "url(assets/fonts/PatrickHand-Regular.ttf)", { weight: "400" }),
  ];
  for (const f of fonts) { await f.load(); document.fonts.add(f); }
  const clips = await (await fetch("assets/audio/clips.json")).json();
  tl = buildTimeline(clips);
  const problems = checkTimeline(tl);
  if (problems.length) console.warn("timeline:", problems.join("; "));
  A = { bird: buildBird(), book: buildBook(), stamps: buildStamps(), hand: buildHand(), keeper: buildKeeper(), props: buildProps(), shots: await Promise.all([1, 2, 3, 4, 5, 6].map((n) => loadImage(`assets/img/app/shot_${n}.jpg`))) };
  desk = sheet(C.kraft, 100, 2200, 1300);
  for (const s of tl.scenes) {
    s.sheet = sheet(...SHEETS[s.id]);
    state[s.id] = MODS[s.id].build(A, tl, s);
  }
  const events = Object.fromEntries(tl.scenes.map((s) => [s.id, MODS[s.id].events(tl)]));
  return { duration: tl.duration, fps: FPS, frames: tl.frames, tl, events };
}

const FROM = { right: [1, 0.06], left: [-1, -0.05], bottom: [0.04, 1], top: [-0.03, -1] };

export function renderAt(t) {
  t = Math.max(0, Math.min(tl.duration, t));
  globalThis.__probe = {};
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  put(ctx, desk, W / 2, H / 2, { sh: 0 });
  for (const s of tl.scenes) {
    if (t < s.start || t >= s.end) continue;
    ctx.save();
    if (s.from) {
      // a fresh sheet of paper slides in over the last one and settles
      const p = E.inOut(prog(t, s.start, s.start + tl.SLIDE));
      const [dx, dy] = FROM[s.from];
      const ox = dx * (W + 140) * (1 - p), oy = dy * (H + 140) * (1 - p);
      ctx.translate(W / 2 + ox, H / 2 + oy);
      ctx.rotate((dx - dy) * 0.035 * (1 - p));
      ctx.translate(-W / 2, -H / 2);
      globalThis.__probe["sheet:" + s.id] = [ox, oy];
      put(ctx, s.sheet, W / 2, H / 2, { lift: 2 + 6 * (1 - p) });
    } else {
      put(ctx, s.sheet, W / 2, H / 2, { sh: 0 });
    }
    ctx.beginPath();
    ctx.rect(-80, -70, W + 160, H + 140);
    ctx.clip();
    MODS[s.id].draw(ctx, t, state[s.id], tl, s);
    ctx.restore();
  }
  return globalThis.__probe;
}

export const film = () => ({ duration: tl.duration, fps: FPS, frames: tl.frames });
