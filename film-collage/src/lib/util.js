// Time, easing and seeded randomness. Everything that moves in the film is a pure function of t built
// from these, so the same t always gives the same frame and motion is continuous between frames.

export const TAU = Math.PI * 2;
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
// Progress of t through [a, b], clamped to 0..1.
export const prog = (t, a, b) => clamp((t - a) / (b - a));

export const E = {
  in: (t) => t * t * t,
  out: (t) => 1 - (1 - t) ** 3,
  // The workhorse ease. Same ends, midpoint and top speed as a cubic in-out, but its acceleration is
  // continuous all the way through (a cubic in-out flips from speeding up to braking in one frame).
  inOut: (t) => { const a = t * t * t, b = (1 - t) ** 3; return a / (a + b); },
  outQuint: (t) => 1 - (1 - t) ** 5,
  inOutQuint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2),
  inOutSine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  outBack: (t, s = 1.5) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2,
};

// Eased move from a to b while t goes from t0 to t1.
export const tween = (t, t0, t1, a, b, ease = E.inOut) => lerp(a, b, ease(prog(t, t0, t1)));

// Step response of an under-damped spring: 0 at t<=0, overshoots, settles at 1.
// f is the natural frequency in Hz, z the damping ratio (0..1). Starts with zero velocity.
export function spring(t, f = 2.4, z = 0.42) {
  if (t <= 0) return 0;
  const w = TAU * f, wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}

// A decaying swing that starts at rest position with full velocity (a knock): amp * e^-kt * sin.
export function swing(t, amp, f = 1.4, k = 1.6) {
  if (t <= 0) return 0;
  return amp * Math.exp(-k * t) * Math.sin(TAU * f * t);
}

// A decaying swing that starts displaced and at rest (a release): amp * e^-kt * cos, eased in.
export function settle(t, amp, f = 1.4, k = 1.6) {
  if (t <= 0) return amp;
  return amp * Math.exp(-k * t) * Math.cos(TAU * f * t);
}

// A smooth bump: 0 -> 1 -> 0 over [t0, t1], with zero slope at both ends.
export const bump = (t, t0, t1) => Math.sin(Math.PI * prog(t, t0, t1)) ** 2;

export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Smooth 1-D value noise in [-1, 1].
export function noise1(seed) {
  const r = mulberry(seed);
  const v = Array.from({ length: 256 }, () => r() * 2 - 1);
  return (x) => {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return lerp(v[i & 255], v[(i + 1) & 255], u);
  };
}

export function fbm1(seed, octaves = 3) {
  const ns = Array.from({ length: octaves }, (_, i) => noise1(seed + i * 101));
  return (x) => {
    let s = 0, a = 1, f = 1, n = 0;
    for (const fn of ns) { s += a * fn(x * f); n += a; a *= 0.5; f *= 2.1; }
    return s / n;
  };
}

// Two-bone arm: where the elbow goes for a shoulder, a hand target and two bone lengths.
export function elbow(sx, sy, hx, hy, l1, l2, bend = 1) {
  let dx = hx - sx, dy = hy - sy;
  let d = Math.hypot(dx, dy);
  const max = l1 + l2 - 0.5;
  if (d > max) { dx *= max / d; dy *= max / d; d = max; }
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const mx = sx + (dx * a) / d, my = sy + (dy * a) / d;
  return { ex: mx - (bend * h * dy) / d, ey: my + (bend * h * dx) / d, hx: sx + dx, hy: sy + dy };
}
