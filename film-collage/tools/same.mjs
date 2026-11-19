// Do separate browser tabs draw the same pixels for the same moment? (The renderer uses several tabs
// and hands consecutive frames to different ones, so they must.)
//   node tools/same.mjs
import { chromium } from "playwright-core";
import { serve } from "../serve.mjs";
const { server, port } = await serve(0);
const extra = process.argv.includes("--gpu") ? [] : ["--disable-accelerated-2d-canvas"];   // as render.mjs draws
const browser = await chromium.launch({ channel: "chrome", args: ["--force-color-profile=srgb", "--disable-gpu-vsync", ...extra] });
const open = async () => { const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } }); await p.goto(`http://127.0.0.1:${port}/index.html?bare`); await p.waitForFunction("window.ready === true", null, { timeout: 120000 }); return p; };
const pages = [await open(), await open(), await open()];
const times = [3.3, 20.7, 33.05, 47.5, 56.0, 66.0, 75.0, 88.0];
const grab = (page, t) => page.evaluate(async (t) => {
  window.renderAt(t);
  const c = document.getElementById("film"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  const h = await crypto.subtle.digest("SHA-256", d);
  return { hash: [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 12), data: Array.from(d.filter((_, i) => i % 4096 === 0)) };
}, t);
let worst = 0;
for (const t of times) {
  const r = [];
  for (const p of pages) r.push(await grab(p, t));
  const same = r.every((x) => x.hash === r[0].hash);
  let maxd = 0;
  for (const x of r) for (let i = 0; i < x.data.length; i++) maxd = Math.max(maxd, Math.abs(x.data[i] - r[0].data[i]));
  worst = Math.max(worst, maxd);
  console.log(`t=${t}: ${r.map((x) => x.hash).join(" ")}  ${same ? "identical in all three tabs" : "DIFFERENT (largest sampled difference " + maxd + " levels)"}`);
}
{ const t0 = Date.now(); await pages[0].evaluate(() => { for (let i = 0; i < 60; i++) window.frameJPEG(2400 + i, 0.97); }); console.log(`60 frames drawn and encoded in one tab: ${((Date.now() - t0) / 60).toFixed(0)} ms each`); }
await browser.close();
server.close();
