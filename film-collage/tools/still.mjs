// Renders single frames to PNG for looking at:  node tools/still.mjs 2.5 7.1 12   (times in seconds)
//   --scale 0.5 writes half-size images; --out dir chooses where (default out/stills).
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../serve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : d; };
const out = path.resolve(opt("out", path.join(HERE, "../out/stills")));
const scale = Number(opt("scale", 1));
const prefix = opt("prefix", "t");
fs.mkdirSync(out, { recursive: true });
const { server, port } = await serve(0);
const browser = await chromium.launch({ channel: "chrome", args: ["--force-color-profile=srgb"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("[page]", m.text()); });
page.on("pageerror", (e) => console.log("[page error]", e.message));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/index.html?bare`);
await page.waitForFunction("window.ready === true", null, { timeout: 60000 });
console.log("boot", Date.now() - t0, "ms", JSON.stringify(await page.evaluate("window.film.duration")));
for (const a of args) {
  const t = Number(a);
  const url = await page.evaluate(([t, scale]) => {
    const u = window.framePNG(t);
    if (scale === 1) return u;
    const src = document.getElementById("film"), c = document.createElement("canvas");
    c.width = src.width * scale; c.height = src.height * scale;
    const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  }, [t, scale]);
  const file = path.join(out, `${prefix}${t.toFixed(2).padStart(6, "0")}.png`);
  fs.writeFileSync(file, Buffer.from(url.split(",")[1], "base64"));
  console.log(file);
}
await browser.close();
server.close();
