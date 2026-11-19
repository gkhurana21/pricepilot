// A tiny static file server for the preview and the renderer (ES modules do not load from file://).
//   node serve.mjs [port]   then open http://localhost:<port>/
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css",
  ".ttf": "font/ttf", ".jpg": "image/jpeg", ".png": "image/png", ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp4": "video/mp4" };

export function serve(port = 0) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(HERE, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(HERE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
    const size = fs.statSync(file).size, range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    const head = { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store", "Accept-Ranges": "bytes" };
    if (range) {
      const a = Number(range[1]), b = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { ...head, "Content-Range": `bytes ${a}-${b}/${size}`, "Content-Length": b - a + 1 });
      fs.createReadStream(file, { start: a, end: b }).pipe(res);
    } else {
      res.writeHead(200, { ...head, "Content-Length": size });
      fs.createReadStream(file).pipe(res);
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await serve(Number(process.argv[2] ?? 4173));
  console.log(`preview: http://localhost:${port}/`);
}
