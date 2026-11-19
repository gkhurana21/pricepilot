// Helpers shared by the scenes.

import { W, H } from "../timeline.js";

// Look at world point (cx, cy) with zoom z. Sub-pixel: nothing is rounded.
export function camera(ctx, cx, cy, z = 1, rot = 0) {
  ctx.translate(W / 2, H / 2);
  ctx.scale(z, z);
  ctx.rotate(rot);
  ctx.translate(-cx, -cy);
}

// Lettering that appears as if being written: wiped on from the left, p = 0..1.
export function writeOn(ctx, sp, x, y, p, o = {}) {
  if (p <= 0) return;
  const { rot = 0, s = 1, a = 1 } = o;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(s, s);
  ctx.globalAlpha *= a;
  if (p < 1) { ctx.beginPath(); ctx.rect(sp.ox, sp.oy, sp.w * p, sp.h); ctx.clip(); }
  ctx.drawImage(sp.c, sp.ox, sp.oy, sp.w, sp.h);
  ctx.restore();
}

// Record where something is on screen this frame, so smoothness can be measured (see tools/smooth.mjs).
export function track(ctx, name, x, y) {
  const probe = globalThis.__probe;
  if (!probe) return;
  const m = ctx.getTransform();
  probe[name] = [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}
