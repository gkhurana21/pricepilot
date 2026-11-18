// Shared helpers for the seeding scripts. Plain Node 22, no dependencies.
//
// All data these scripts touch is SYNTHETIC: see README.md.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SEED_DIR = dirname(fileURLToPath(import.meta.url));
// `shopify app execute` must be run from the app directory (shopify-app/).
export const APP_DIR = join(SEED_DIR, "..");
export const STATE_FILE = join(SEED_DIR, ".state.json");

export const TAG_SYNTHETIC = "pricepilot-synthetic";
export const TAG_PRODUCT = "pricepilot-seed";
export const dayTag = (date) => `pp-seed-${date}`;
export const DAY_TAG_RE = /^pp-seed-(\d{4}-\d{2}-\d{2})$/;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- command line ------------------------------------------------------------

// parseArgs: `--flag` is boolean, `--name value` takes a value. Unknown
// options are an error so a typo cannot silently run something else.
export function parseArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (!(key in spec)) throw new Error(`unknown option: ${a}`);
    if (spec[key] === "boolean") out[key] = true;
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`option ${a} needs a value`);
      out[key] = v;
    }
  }
  return out;
}

// ---- money, by string arithmetic (never floats) ---------------------------------

// moneyToCents("21.5") === 2150, "21" -> 2100, "21.50" -> 2150, "21.500" -> 2150.
// Throws on anything that is not a non-negative decimal with a whole number of
// cents, so a surprising value is reported instead of being rounded away.
export function moneyToCents(s) {
  if (typeof s !== "string") throw new Error(`money must be a string, got ${typeof s}`);
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s.trim());
  if (!m) throw new Error(`not a money amount: ${JSON.stringify(s)}`);
  const whole = m[1];
  const frac = m[2] ?? "";
  if (/[^0]/.test(frac.slice(2))) throw new Error(`not a whole number of cents: ${JSON.stringify(s)}`);
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents)) throw new Error(`amount out of range: ${JSON.stringify(s)}`);
  return cents;
}

export function centsToMoney(c) {
  if (!Number.isInteger(c) || c < 0) throw new Error(`bad cents: ${c}`);
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

// ---- plan ----------------------------------------------------------------------

export function loadPlan(path) {
  const plan = JSON.parse(readFileSync(path, "utf8"));
  if (plan.synthetic !== true) throw new Error(`${path}: not a synthetic plan (synthetic !== true)`);
  const n = plan.history?.dates?.length;
  if (!n || !Array.isArray(plan.products)) throw new Error(`${path}: malformed plan`);
  for (const p of plan.products) {
    if (p.prices.length !== n || p.units.length !== n) throw new Error(`${path}: ${p.handle} series length differs from the date list`);
  }
  return plan;
}

// ---- running GraphQL as the app ------------------------------------------------

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const clean = (s) => String(s).replace(ANSI, "").replace(/[│╭╮╰╯─]/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

export class GqlError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

// gql runs one query or mutation through the shopify CLI and returns its data
// object. Output goes to a file because the CLI's stdout is not clean JSON.
export function gql(store, query, variables) {
  const dir = mkdtempSync(join(tmpdir(), "pp-seed-"));
  const out = join(dir, "out.json");
  const args = ["app", "execute", "-s", store, "-q", query, "--no-color", "--output-file", out];
  if (variables) args.push("-v", JSON.stringify(variables));
  try {
    let log = "";
    let failed = false;
    try {
      log = execFileSync("shopify", args, { cwd: APP_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      failed = true;
      log = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
    }
    if (existsSync(out)) {
      const txt = readFileSync(out, "utf8");
      if (txt.trim()) {
        try {
          return JSON.parse(txt);
        } catch {
          /* fall through to the error below */
        }
      }
    }
    const why = clean(log).slice(0, 800) || "no output";
    throw new GqlError(`shopify app execute ${failed ? "failed" : "wrote no result"}: ${why}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function userErrorsOf(data) {
  const errs = [];
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v.userErrors) && v.userErrors.length) errs.push(...v.userErrors);
    for (const k of Object.keys(v)) if (k !== "userErrors") walk(v[k]);
  };
  walk(data);
  return errs;
}

const THROTTLE = /throttl|too many|rate.?limit|429|try again|limit/i;

// withRetry retries a failing call up to `retries` times with growing waits.
// `beforeRetry` runs before each retry (used to re-check that a "failed" order
// was not in fact created). Non-throttle userErrors are not retried.
export async function withRetry(label, fn, { retries = 3, baseMs = 20000, beforeRetry } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = baseMs * 2 ** (attempt - 1);
      console.log(`  retry ${attempt}/${retries} for ${label} in ${Math.round(wait / 1000)}s (${last.message.slice(0, 160)})`);
      await sleep(wait);
      if (beforeRetry) {
        const done = await beforeRetry();
        if (done !== undefined) return done;
      }
    }
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e instanceof GqlError && e.retryable === false) throw e;
    }
  }
  throw new Error(`${label} failed after ${retries + 1} attempts: ${last.message}`);
}

export function checkUserErrors(label, data) {
  const errs = userErrorsOf(data);
  if (errs.length) {
    const msg = errs.map((e) => `${(e.field ?? []).join(".")}: ${e.message}`).join("; ");
    throw new GqlError(`${label}: ${msg}`, { retryable: THROTTLE.test(msg) });
  }
}
