// Sync table: for each narration line, when the words are spoken and when the matching action lands.
// Sentence starts are measured from the clips; a word inside a sentence is placed by its position in
// the text, which is an estimate (see checkWords below for a measured cross-check).
//
//   node tools/sync.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildTimeline } from "../src/timeline.js";
import * as lever from "../src/scenes/lever.js";
import * as stall from "../src/scenes/stall.js";
import * as stamps from "../src/scenes/stamps.js";
import * as apply from "../src/scenes/apply.js";
import * as scroll from "../src/scenes/scroll.js";
import * as card from "../src/scenes/card.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const clips = JSON.parse(fs.readFileSync(path.join(HERE, "../assets/audio/clips.json"), "utf8"));
const tl = buildTimeline(clips);
const L = lever.events(tl), S = stall.events(tl), T = stamps.events(tl), A = apply.events(tl), R = scroll.events(tl), K = card.events(tl);
const w = (p, word) => tl.word(p, word), p = (id) => tl.p(id).start;

// [line, words, time the words start, action, time the action lands]
const rows = [
  ["1", "one percent", w("01a", "one percent"), "hand sets the 1% tag on the arm", L.one],
  ["1", "profit moves", w("01a", "profit"), "arm begins to lift (far end rises)", L.profit - 0.3],
  ["1", "eleven", w("01a", "eleven"), "cut-out 11% lands on the far end", L.eleven - 0.12],
  ["1", "In either direction", p("01b"), "arm swings the other way", L.either - 0.05],
  ["2", "by hand", w("02a", "hand"), "she has lifted the tag off its peg", S.hand - 0.1],
  ["2", "Carefully", p("02b"), "pencil brought up to the tag", S.careful],
  ["2", "Nervously", p("02c"), "hands shake, pencil tangle, drops", S.nervous + 0.1],
  ["3", "a helper", w("03a", "helper"), "the bird touches down", S.land],
  ["3", "reads the order history", w("03b", "reads"), "order roll starts to unroll", S.reads - 0.05],
  ["3", "suggests a price", w("03b", "suggests"), "$17.62 tag comes out", S.suggests - 0.1],
  ["4", "never", w("04a", "never"), "gate arm reaches the bottom", S.shut + 0.4],
  ["4", "A rulebook", p("04b"), "rulebook lands on its stand", S.drop + 0.36],
  ["4", "rulebook does", w("04b", "rulebook"), "cover starts to open", S.open],
  ["4", "Your margin floor", p("04c"), "\"margin floor\" starts being written", S.r1],
  ["4", "How far a price may move", p("04d"), "second rule starts being written", S.r2],
  ["4", "What is off limits", p("04e"), "third rule starts being written", S.r3],
  ["4", "(in the pause after line 4)", tl.p("04e").end + 1.55, "$18.99 tag comes down from the gate", S.fix + 0.3],
  ["5", "accepted", w("05a", "accepted"), "green stamp hits", T.T[0]],
  ["5", "adjusted", w("05a", "adjusted"), "amber stamp hits", T.T[1]],
  ["5", "refused", w("05a", "refused"), "red stamp hits", T.T[2]],
  ["5", "names its rule", w("05b", "names"), "\"excluded by policy\" is ringed", T.names - 0.05],
  ["6", "Here is the real app", p("06a"), "print 1 is on the sheet; label being written", A.a - 0.2],
  ["6", "inside Shopify", w("06a", "inside"), "bracket drawn beside the Shopify admin's sidebar", A.inside - 0.1],
  ["6", "The order history here is", p("06b"), "camera has started in to reading distance", A.push],
  ["6", "synthetic", w("06b", "synthetic"), "ring starts round the yellow notice", A.synth - 0.1],
  ["7a", "Refusals come first", p("07a"), "line under the \"Held back\" heading", A.refuse + 0.1],
  ["7a", "reasons listed", w("07a", "reasons"), "ring round \"Change too small\", then a brace by the reasons", A.reasons - 0.1],
  ["7b", "the four prices", w("07b", "four prices"), "line under \"4 adjusted by a guardrail\"", A.count - 0.25],
  ["7b", "pulled back, (phrase ends)", tl.p("07b").end, "print 2 (Adjusted by a guardrail) is dealt", A.deal[1]],
  ["7c", "that passed", w("07c", "passed"), "print 3 (Accepted) is dealt", A.deal[2]],
  ["8", "Apply", p("08a"), "finger presses apply", A.apply],
  ["8", "(after the press)", A.apply, "print 4 (apply report) is dealt", A.deal[3]],
  ["8", "read back", w("08a", "read back"), "line under \"verified by re-reading prices\"", Math.max(A.read - 0.05, A.land[3])],
  ["9a", "Change your mind (at \"mind\")", w("09a", "mind"), "finger presses roll back", A.roll],
  ["9a", "(after the press)", A.roll, "print 5 (Roll back this run?) is dealt", A.deal[4]],
  ["9b", "everything goes back", w("09b", "everything"), "print 6 (rollback report) is dealt", A.deal[5]],
  ["10", "sixty-two million", w("10a", "sixty-two"), "count card has arrived", R.count],
  ["10", "the rules give a wrong answer", w("10a", "the rules"), "\"0 violations\" starts being written", R.wrong - 0.2],
  ["10", "They never did", p("10b"), "green stamp hits", R.never],
  ["11", "The agent suggests.", p("11a"), "bird lands; line starts being written", K.a - 0.02],
  ["11", "The rules decide.", p("11b"), "rulebook lands; line starts being written", K.b + 0.06],
];
let worst = 0;
console.log("line | words                      | words at | action at | offset  | action");
for (const [line, words, tw, action, ta] of rows) {
  const off = ta - tw;
  worst = Math.max(worst, Math.abs(off));
  console.log(`${line.padEnd(4)} | ${words.padEnd(29)} | ${tw.toFixed(2).padStart(6)} s | ${ta.toFixed(2).padStart(7)} s | ${(off >= 0 ? "+" : "") + off.toFixed(2)} s | ${action}`);
}
console.log(`largest offset: ${worst.toFixed(2)} s (the brief asks for about half a second)`);
console.log(`film length ${tl.duration.toFixed(3)} s; narration: ${clips.voice}`);

// Cross-check of the word estimate, measured: in line 5 the commas after "accepted" and "adjusted"
// leave short pauses in the audio; the words after them must start where the estimate says.
const file = path.join(HERE, "../assets/audio", tl.lines["05"].file);
const r = spawnSync("/opt/homebrew/bin/ffmpeg", ["-hide_banner", "-i", file, "-af", "silencedetect=noise=-30dB:d=0.04", "-f", "null", "-"], { encoding: "utf8" });
const ends = [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]) + tl.lines["05"].start);
console.log("\nword estimate against measured pauses in line 5 (a word starts where a pause ends):");
for (const word of ["adjusted", "or refused"]) {
  const est = tl.word("05a", word), near = ends.reduce((a, b) => (Math.abs(b - est) < Math.abs(a - est) ? b : a), Infinity);
  console.log(`  "${word}": estimated ${est.toFixed(2)} s, nearest measured pause end ${Number.isFinite(near) ? near.toFixed(2) + " s (difference " + (est - near).toFixed(2) + " s)" : "none found"}`);
}
