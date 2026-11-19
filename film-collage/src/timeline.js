// The film's clock, built from the real lengths of the narration clips (assets/audio/clips.json).
// Picture and sound both read their times from here, so they cannot drift apart: change the voice,
// regenerate the clips, and every scene, cut and sound effect moves with the words.

import { LINES, TAIL } from "./script.js";

export const FPS = 60;
export const W = 1920;
export const H = 1080;

export function buildTimeline(clips) {
  const lines = {}, parts = {};
  let t = 0;
  for (const line of LINES) {
    const clip = clips.lines[line.id];
    if (!clip) throw new Error(`no narration clip for line ${line.id}; run tts.mjs`);
    t += line.gap;
    lines[line.id] = { start: t, end: t + clip.duration, file: clip.file };
    for (const p of clip.parts) {
      // pauses that fall inside this sentence (not the ones that bound it), in film time
      const inside = (clip.pauses ?? []).filter(([s, e]) => s > p.start + 0.05 && e < p.end - 0.05).map(([s, e]) => [t + s, t + e]);
      parts[p.id] = { start: t + p.start, end: t + p.end, text: p.text, pauses: inside };
    }
    t += clip.duration;
  }
  // Round the length up to a whole frame.
  const duration = Math.ceil((t + TAIL) * FPS) / FPS;

  // When a word starts. Where the voice paused at each comma of the sentence, the pauses are measured
  // anchors and the word is placed by its position inside its own phrase; otherwise by its position in
  // the whole sentence (speech is close to even in characters per second: good to a few tenths).
  const word = (partId, w, nth = 0) => {
    const p = parts[partId];
    let i = -1;
    for (let k = 0; k <= nth; k++) i = p.text.toLowerCase().indexOf(w.toLowerCase(), i + 1);
    if (i < 0) throw new Error(`"${w}" is not in part ${partId}`);
    const commas = [...p.text.matchAll(/, /g)].map((m) => m.index + 2);
    if (commas.length && commas.length <= p.pauses.length) {
      // one pause per comma: the longest ones, in order (a voice may also take a shorter breath elsewhere)
      const at = [...p.pauses].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, commas.length).sort((a, b) => a[0] - b[0]);
      const k = commas.filter((c) => c <= i).length;                       // which phrase the word is in
      const c0 = k === 0 ? 0 : commas[k - 1], c1 = k === commas.length ? p.text.length : commas[k] - 2;
      const t0 = k === 0 ? p.start : at[k - 1][1], t1 = k === commas.length ? p.end : at[k][0];
      return t0 + ((i - c0) / Math.max(1, c1 - c0)) * (t1 - t0);
    }
    return p.start + (i / p.text.length) * (p.end - p.start);
  };
  const L = (id) => lines[id];
  const p = (id) => parts[id];

  // Scenes. A new sheet of paper slides in just before each of these lines begins.
  // The sheet settles as the line's first word is spoken. (Scene 3's sheet comes a little later, so the
  // $18.99 tag it covers has been readable for two and a half seconds.)
  const SLIDE = 0.9;
  const cut = (lineId, lead = 0.85) => L(lineId).start - lead;
  const scenes = [
    { id: "lever", start: 0, lines: ["01"] },
    { id: "stall", start: cut("02"), lines: ["02", "03", "04"], from: "left" },   // from the left, so the 11% is covered last
    { id: "stamps", start: cut("05", 0.6), lines: ["05"], from: "right" },
    { id: "apply", start: cut("06"), lines: ["06", "07", "07b", "07c", "08", "09", "09b"], from: "bottom" },
    { id: "scroll", start: cut("10"), lines: ["10"], from: "left" },   // from the left: the ticks on the last print are covered last
    { id: "card", start: cut("11"), lines: ["11"], from: "top" },
  ];
  scenes.forEach((s, i) => { s.end = i + 1 < scenes.length ? scenes[i + 1].start + SLIDE + 0.1 : duration; });

  return { duration, frames: Math.round(duration * FPS), lines, parts, word, L, p, scenes, SLIDE };
}

// Checks the brief asks for: total length, and no line of speech running into the next.
export function checkTimeline(tl) {
  const problems = [];
  if (tl.duration < 45) problems.push(`duration ${tl.duration.toFixed(2)} s is under 45 s`);   // no upper limit: the pace decides the length
  const ids = Object.keys(tl.lines).sort((a, b) => tl.lines[a].start - tl.lines[b].start);
  ids.forEach((id, i) => { if (i && tl.lines[id].start < tl.lines[ids[i - 1]].end + 0.3) problems.push(`line ${id} starts less than 0.3 s after line ${ids[i - 1]} ends`); });
  return problems;
}
