// Narration: one clip per line of src/script.js, measured with ffprobe.
//
//   List speech models:  node --env-file=/path/to/.env tts.mjs --list
//   Audition (lines 1-2): node --env-file=/path/to/.env tts.mjs --audition --model M --voices a,b,c
//   Generate everything:  node --env-file=/path/to/.env tts.mjs --model M --voice V
//   Local placeholder:    node tts.mjs --backend say --voice Daniel --rate 158
//   --dir <folder> writes the clips somewhere other than assets/audio (to compare two voices);
//   --only 03,05 regenerates just those lines.
//
// The key is read from OPENROUTER_API_KEY in the process environment. It is never printed, logged or
// written to a file. OpenRouter is used for speech only.
//
// Writes assets/audio/line-<id>.wav (48 kHz mono, edges trimmed), assets/audio/clips.json (durations and
// where each sentence starts and ends inside its line), assets/audio/VOICE.txt and, for OpenRouter,
// out/SPEND.json (the key's usage before and after, numbers only; not committed).

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LINES, lineText } from "./src/script.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIO = process.argv.includes("--dir") ? path.resolve(process.argv[process.argv.indexOf("--dir") + 1]) : path.join(HERE, "assets/audio");
const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const FFPROBE = "/opt/homebrew/bin/ffprobe";
const TMP = path.join(HERE, "out/tts-tmp");
const API = "https://openrouter.ai/api/v1";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);

const backend = opt("backend", "openrouter");
const model = opt("model", "elevenlabs/eleven-multilingual-v2");
const voice = opt("voice", "");
const rate = opt("rate", "158");
const MAX_CALL_USD = 0.5;   // a single call estimated above this is refused
const MAX_RUN_USD = 2.0;    // a whole run estimated above this is refused

fs.mkdirSync(AUDIO, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

function keyHeaders() {
  const k = process.env.OPENROUTER_API_KEY;
  if (!k) throw new Error("OPENROUTER_API_KEY is not set (load it with node --env-file=...)");
  return { Authorization: `Bearer ${k}`, "Content-Type": "application/json" };
}

// Usage figures only. The response's label (which contains part of the key) is never read.
async function keyUsage() {
  const r = await fetch(`${API}/key`, { headers: keyHeaders() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { at: new Date().toISOString(), status: r.status, error: String(j?.error?.message ?? "unknown").slice(0, 120) };
  const d = j?.data ?? {};
  return { at: new Date().toISOString(), status: r.status, usage: d.usage, limit: d.limit, limit_remaining: d.limit_remaining };
}

async function speechModels() {
  const r = await fetch(`${API}/models?output_modalities=speech`);
  const j = await r.json();
  return j.data ?? [];
}

// Price per input character in USD, as listed by the Models API (speech models are priced on input).
async function pricePerChar(id) {
  const m = (await speechModels()).find((x) => x.id === id);
  if (!m) throw new Error(`model ${id} is not in the speech model list`);
  const p = Number(m.pricing?.prompt ?? 0), c = Number(m.pricing?.completion ?? 0);
  if (c > 0) throw new Error(`model ${id} bills on output (${c}); estimate its cost by hand before using it`);
  return p;
}

async function openrouterSpeech(text, v, outFile) {
  const body = { model, input: text, voice: v, response_format: "mp3" };
  const r = await fetch(`${API}/audio/speech`, { method: "POST", headers: keyHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`speech ${r.status}: ${(await r.text()).slice(0, 200)}`);
  fs.writeFileSync(outFile, Buffer.from(await r.arrayBuffer()));
}

const ff = (a) => execFileSync(FFMPEG, ["-y", "-v", "error", ...a]);

// Convert to 48 kHz mono WAV and trim leading and trailing silence.
function normaliseClip(src, dst) {
  const trim = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02," +
    "areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse";
  ff(["-i", src, "-af", trim, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", dst]);
}

const duration = (file) =>
  Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());

// Silences of at least 120 ms below -34 dB, as [start, end] pairs.
function silences(file) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-i", file, "-af", "silencedetect=noise=-34dB:d=0.12", "-f", "null", "-"], { encoding: "utf8" });
  const starts = [...r.stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  return starts.map((s, i) => [s, ends[i] ?? s]).filter(([s, e]) => e > s);
}

// Where each sentence sits inside a whole-line clip. A line with n sentences has n-1 sentence breaks,
// and a voice pauses longest at a full stop: so the breaks are the n-1 longest pauses, provided each
// falls roughly where the text says it should. Otherwise fall back to character proportions.
// Every pause is kept too (as [start, end] in clip time), so words after a comma can be timed from it.
function locateParts(line, file, dur) {
  const texts = line.parts.map((p) => p.text);
  const total = texts.join(" ").length;
  const expected = [];
  let acc = 0;
  for (let i = 0; i < texts.length - 1; i++) { acc += texts[i].length + 1; expected.push((acc / total) * dur); }
  const round = (x) => Number(x.toFixed(3));
  const sil = silences(file).filter(([s, e]) => s > 0.1 && e < dur - 0.1);
  const pauses = sil.map(([s, e]) => [round(s), round(e)]);
  const picked = [...sil].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, expected.length).sort((a, b) => a[0] - b[0]);
  const ok = picked.length === expected.length && picked.every((s, i) => Math.abs((s[0] + s[1]) / 2 - expected[i]) < Math.max(1.2, dur * 0.25));
  if (ok) {
    return { method: "pauses", pauses, parts: line.parts.map((p, i) => ({ id: p.id, start: round(i === 0 ? 0 : picked[i - 1][1]), end: round(i === line.parts.length - 1 ? dur : picked[i][0]), text: p.text })) };
  }
  const bounds = [0, ...expected, dur];
  return { method: "proportional", pauses, parts: line.parts.map((p, i) => ({ id: p.id, start: round(bounds[i]), end: round(bounds[i + 1]), text: p.text })) };
}

// Local placeholder: speak each sentence with macOS `say`, join with the script's pauses.
function sayLine(line, v, dst) {
  const pieces = [];
  const parts = [];
  let t = 0;
  line.parts.forEach((p, i) => {
    const aiff = path.join(TMP, `${p.id}.aiff`), wav = path.join(TMP, `${p.id}.wav`);
    execFileSync("say", ["-v", v, "-r", String(rate), "-o", aiff, p.text]);
    normaliseClip(aiff, wav);
    const d = duration(wav);
    if (i > 0) {
      const gap = p.pause ?? 0.4, sil = path.join(TMP, `${p.id}-gap.wav`);
      ff(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", String(gap), "-c:a", "pcm_s16le", sil]);
      pieces.push(sil); t += gap;
    }
    parts.push({ id: p.id, start: Number(t.toFixed(3)), end: Number((t + d).toFixed(3)), text: p.text });
    pieces.push(wav); t += d;
  });
  const list = path.join(TMP, `${line.id}.txt`);
  fs.writeFileSync(list, pieces.map((f) => `file '${f}'`).join("\n") + "\n");
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c:a", "pcm_s16le", dst]);
  return { method: "say-parts", parts };
}

async function main() {
  if (flag("list")) {
    for (const m of await speechModels()) console.log(m.id, "|", m.pricing?.prompt, "|", (m.supported_voices ?? []).slice(0, 24).join(","));
    return;
  }
  if (!voice && !flag("audition") && !flag("relocate")) throw new Error("--voice is required");

  let before = null, perChar = 0;
  const online = backend === "openrouter" && !flag("relocate");
  if (online) {
    before = await keyUsage();
    console.log("key usage before:", JSON.stringify(before));
    if (before.status !== 200) throw new Error(`OpenRouter rejected the key (${before.status}: ${before.error}); nothing generated, nothing spent.`);
    perChar = await pricePerChar(model);
  }
  const guard = (chars, calls) => {
    if (!online) return;
    const est = chars * perChar;
    console.log(`estimated cost: ${chars} characters x ${perChar} = $${est.toFixed(4)} over ${calls} calls`);
    if (est > MAX_RUN_USD) throw new Error("estimated run cost is above the run cap; not generating");
  };
  const guardCall = (text) => {
    if (online && text.length * perChar > MAX_CALL_USD) throw new Error("a single call is estimated above $0.50; not generating");
  };

  if (flag("audition")) {
    const voices = opt("voices", voice).split(",").filter(Boolean);
    const text = LINES.slice(0, 2).map(lineText).join(" ");
    guard(text.length * voices.length, voices.length);
    const dir = path.join(HERE, "out/audition");
    fs.mkdirSync(dir, { recursive: true });
    for (const v of voices) {
      guardCall(text);
      const tag = `${backend === "say" ? "say" : model.replace(/\W+/g, "_")}-${v.replace(/\W+/g, "_")}`;
      const raw = path.join(TMP, `audition-${tag}.${backend === "say" ? "aiff" : "mp3"}`);
      if (backend === "say") execFileSync("say", ["-v", v, "-r", String(rate), "-o", raw, text]);
      else await openrouterSpeech(text, v, raw);
      const wav = path.join(dir, `${tag}.wav`);
      normaliseClip(raw, wav);
      const d = duration(wav), words = text.split(/\s+/).length;
      const sp = silences(wav).reduce((s, [a, b]) => s + (b - a), 0);
      console.log(`audition ${tag}: ${d.toFixed(2)} s, ${(words / (d / 60)).toFixed(0)} words/min overall, ${(words / ((d - sp) / 60)).toFixed(0)} while speaking, ${sp.toFixed(2)} s of pauses`);
    }
  } else {
    const only = opt("only", "").split(",").filter(Boolean);
    const todo = LINES.filter((l) => !only.length || only.includes(l.id));
    guard(todo.reduce((s, l) => s + lineText(l).length, 0), todo.length);
    const file = path.join(AUDIO, "clips.json");
    const clips = fs.existsSync(file) && (only.length || flag("relocate")) ? JSON.parse(fs.readFileSync(file, "utf8")) : { lines: {} };
    for (const line of todo) {
      const wav = path.join(AUDIO, `line-${line.id}.wav`);
      let located;
      if (flag("relocate")) located = locateParts(line, wav, duration(wav));   // re-measure existing clips, no API call
      else if (backend === "say") located = sayLine(line, voice, wav);
      else {
        const text = lineText(line);
        guardCall(text);
        const raw = path.join(TMP, `line-${line.id}.mp3`);
        await openrouterSpeech(text, voice, raw);
        normaliseClip(raw, wav);
        located = locateParts(line, wav, duration(wav));
      }
      const d = Number(duration(wav).toFixed(3));
      clips.lines[line.id] = { file: `line-${line.id}.wav`, duration: d, located: located.method, parts: located.parts, pauses: located.pauses ?? [] };
      console.log(line.id, d.toFixed(2) + " s", located.method, located.parts.map((p) => `${p.id} ${p.start}-${p.end}`).join("  "));
    }
    if (flag("relocate")) { fs.writeFileSync(file, JSON.stringify(clips, null, 2) + "\n"); return; }
    clips.backend = backend;
    clips.voice = backend === "say" ? `macOS say "${voice}" at ${rate} wpm` : `${model} "${voice}"`;
    fs.writeFileSync(file, JSON.stringify(clips, null, 2) + "\n");
    const who = backend === "say"
      ? `macOS "say", voice "${voice}", rate ${rate} words per minute. LOCAL PLACEHOLDER, not the intended voice.`
      : `OpenRouter speech endpoint (POST ${API}/audio/speech), model ${model}, voice "${voice}".`;
    fs.writeFileSync(path.join(AUDIO, "VOICE.txt"),
      `Narration: ${who}\nGenerated: ${new Date().toISOString().slice(0, 10)}\n` +
      "One clip per line of src/script.js; edges trimmed with ffmpeg silenceremove; durations measured with ffprobe (clips.json).\n");
  }

  if (online) {
    const after = await keyUsage();
    console.log("key usage after:", JSON.stringify(after));
    const log = path.join(HERE, "out/SPEND.json");
    const runs = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf8")) : [];
    runs.push({ what: flag("audition") ? `audition (${opt("voices", voice)})` : `narration (${voice}${opt("only", "") ? ", lines " + opt("only", "") : ""})`, model, before, after, spent_usd: Number(((after.usage ?? 0) - (before.usage ?? 0)).toFixed(6)) });
    fs.writeFileSync(log, JSON.stringify(runs, null, 2) + "\n");
  }
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
