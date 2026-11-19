// Renders the film: every frame drawn by headless Chrome from renderAt(t), encoded with ffmpeg and
// joined to the soundtrack from audio.mjs.
//
//   node render.mjs                     the whole film -> out/pricepilot-collage.mp4
//   node render.mjs --from 28 --to 31   only part of it (for checking a passage; no sound)
//   node render.mjs --workers 6 --keep  more browser tabs; keep the frame files afterwards
//
// The page is deterministic (same t, same pixels), so frames can be drawn out of order by several tabs.

import { chromium } from "playwright-core";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = "/opt/homebrew/bin/ffmpeg", FFPROBE = "/opt/homebrew/bin/ffprobe";
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes(`--${n}`);

const OUT = path.join(HERE, "out");
const FRAMES = path.join(OUT, "frames");
const workers = Number(opt("workers", 6));
const quality = Number(opt("quality", 0.97));
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

const { server, port } = await serve(0);
// The canvas is drawn in software, not on the GPU. It is about four times slower, but then every tab
// produces exactly the same pixels for the same frame (tools/same.mjs checks this); with the GPU
// canvas one tab in a run occasionally differed from the others by one level in a few pixels.
// `--gpu` uses the GPU canvas (for a quick look, not for the final file).
const canvasArgs = args.includes("--gpu") ? [] : ["--disable-accelerated-2d-canvas"];
const browser = await chromium.launch({ channel: "chrome", args: ["--force-color-profile=srgb", "--disable-gpu-vsync", ...canvasArgs] });
const url = `http://127.0.0.1:${port}/index.html?bare`;
const open = async () => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on("pageerror", (e) => { console.error("[page error]", e.message); process.exitCode = 1; });
  await page.goto(url);
  await page.waitForFunction("window.ready === true", null, { timeout: 120000 });
  return page;
};
const first = await open();
const film = await first.evaluate("window.film");
const partial = args.includes("--from") || args.includes("--to");
const f0 = Math.max(0, Math.round(Number(opt("from", 0)) * film.fps));
const f1 = Math.min(film.frames, Math.round(Number(opt("to", film.duration)) * film.fps));
console.log(`film: ${film.duration.toFixed(3)} s, ${film.frames} frames at ${film.fps} fps; rendering frames ${f0}..${f1 - 1} with ${workers} tabs`);

const pages = [first, ...(await Promise.all(Array.from({ length: workers - 1 }, open)))];
let next = f0, done = 0;
const t0 = Date.now();
await Promise.all(pages.map(async (page) => {
  for (;;) {
    const i = next++;
    if (i >= f1) return;
    const data = await page.evaluate(([i, q]) => window.frameJPEG(i, q), [i, quality]);
    fs.writeFileSync(path.join(FRAMES, `f_${String(i - f0).padStart(5, "0")}.jpg`), Buffer.from(data.slice(data.indexOf(",") + 1), "base64"));
    if (++done % 300 === 0) console.log(`  ${done}/${f1 - f0} frames, ${((Date.now() - t0) / done).toFixed(0)} ms each`);
  }
}));
console.log(`frames drawn in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await browser.close();
server.close();

const mix = path.join(OUT, "audio/mix.wav");
const name = partial ? `part-${opt("from", 0)}-${opt("to", "end")}.mp4` : "pricepilot-collage.mp4";
const target = path.join(OUT, name);
const video = ["-framerate", String(film.fps), "-i", path.join(FRAMES, "f_%05d.jpg")];
const audio = !partial && fs.existsSync(mix) ? ["-i", mix] : [];
if (!partial && !audio.length) console.warn("no out/audio/mix.wav: run `node audio.mjs` first; writing a silent film");
execFileSync(FFMPEG, ["-y", "-v", "error", "-stats", ...video, ...audio,
  // Chrome's JPEGs are full-range BT.601; the film is tagged and encoded as limited-range BT.709
  "-vf", "scale=1920:1080:in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p",
  "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "15", "-r", String(film.fps),
  "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
  ...(audio.length ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : []),
  "-movflags", "+faststart", target], { stdio: "inherit" });
if (!flag("keep")) fs.rmSync(FRAMES, { recursive: true, force: true });

const probe = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_frames,sample_rate,channels,bit_rate:format=duration,size", "-of", "json", target], { encoding: "utf8" });
fs.writeFileSync(target.replace(/\.mp4$/, ".ffprobe.json"), probe.stdout);
console.log(target);
console.log(probe.stdout.replace(/\s+/g, " "));
