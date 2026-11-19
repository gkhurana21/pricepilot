// Prints the OpenRouter key's usage figures (never the key or its label).
//   node --env-file=/path/to/.env tools/or-key.mjs            print
//   node --env-file=/path/to/.env tools/or-key.mjs --total    also append a "total" entry to
//        out/SPEND.json: usage now minus usage before the first recorded call. The per-call
//        entries there can lag (OpenRouter posts usage a little after a call), so the total is the
//        figure to trust, read once the calls have settled.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const k = process.env.OPENROUTER_API_KEY;
if (!k) { console.error("OPENROUTER_API_KEY not set"); process.exit(1); }
const H = { Authorization: `Bearer ${k}` };
const get = async (p) => {
  const r = await fetch("https://openrouter.ai/api/v1" + p, { headers: H });
  let j = {};
  try { j = await r.json(); } catch {}
  return { status: r.status, data: j.data ?? {}, error: j.error ? String(j.error.message).slice(0, 100) : undefined };
};
const key = await get("/key"), credits = await get("/credits");
const now = { at: new Date().toISOString(), status: key.status, usage: key.data.usage, usage_daily: key.data.usage_daily, limit: key.data.limit, account_total_usage: credits.data.total_usage, error: key.error };
console.log(JSON.stringify(now));
if (process.argv.includes("--total") && key.status === 200) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../out/SPEND.json");
  const runs = JSON.parse(fs.readFileSync(file, "utf8")).filter((r) => r.what !== "total");
  const first = runs[0].before.usage ?? 0;
  runs.push({ what: "total", key_usage_before_first_call: first, key_usage_now: now.usage, spent_usd: Number((now.usage - first).toFixed(6)), read_at: now.at });
  fs.writeFileSync(file, JSON.stringify(runs, null, 2) + "\n");
  console.log(`total spent on this key by this film: $${(now.usage - first).toFixed(5)}`);
}
