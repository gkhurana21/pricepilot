#!/usr/bin/env node
// Reads every synthetic order back from the store and compares each
// (day, product) units and price with the plan, exactly.
//
//   node seed/verify.mjs --plan seed/plan.json --store <store>.myshopify.com
//
// Exit 0 only when every day and every product matches. Read-only.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DAY_TAG_RE, STATE_FILE, SEED_DIR, TAG_SYNTHETIC, gql, loadPlan, moneyToCents, parseArgs, withRetry } from "./lib.mjs";

export { moneyToCents };

// The calendar day (UTC) of an ISO timestamp.
export const utcDay = (iso) => new Date(iso).toISOString().slice(0, 10);

// compare: plan -> what the store returned -> list of differences.
//   orders: [{ id, name, processedAt, tags, lineItems: { nodes: [...] } }]
//   variantToHandle: { "<variant gid>": "<handle>" }
// Orders without a pp-seed-YYYY-MM-DD tag are not seed orders (for example a
// probe order) and are returned in `ignored`, not treated as mismatches.
export function compare(plan, orders, variantToHandle) {
  const mismatches = [];
  const ignored = [];
  const byDay = new Map();
  for (const o of orders) {
    const tag = (o.tags ?? []).map((t) => DAY_TAG_RE.exec(t)).find(Boolean);
    if (!tag) {
      ignored.push(o.name ?? o.id);
      continue;
    }
    if (!byDay.has(tag[1])) byDay.set(tag[1], []);
    byDay.get(tag[1]).push(o);
  }

  const planDays = new Set(plan.history.dates);
  for (const day of [...byDay.keys()].sort()) {
    if (!planDays.has(day)) mismatches.push(`${day}: order in the store for a day that is not in the plan`);
  }

  let matchedDays = 0;
  let seededDays = 0;
  plan.history.dates.forEach((day, i) => {
    const found = byDay.get(day) ?? [];
    if (found.length === 0) {
      mismatches.push(`${day}: no order in the store`);
      return;
    }
    seededDays++;
    if (found.length > 1) {
      mismatches.push(`${day}: ${found.length} orders in the store (${found.map((o) => o.name).join(", ")}), want 1`);
      return;
    }
    const o = found[0];
    const before = mismatches.length;
    if (utcDay(o.processedAt) !== day) mismatches.push(`${day}: ${o.name} processedAt is ${o.processedAt}, want that day`);

    const got = new Map();
    for (const li of o.lineItems.nodes) {
      const handle = variantToHandle[li.variant?.id];
      if (!handle) {
        mismatches.push(`${day}: ${o.name} has a line for an unknown variant ${li.variant?.id ?? "(none)"}`);
        continue;
      }
      if (got.has(handle)) {
        mismatches.push(`${day}: ${o.name} has two lines for ${handle}`);
        continue;
      }
      let cents;
      try {
        cents = moneyToCents(li.originalUnitPriceSet.shopMoney.amount);
      } catch (e) {
        mismatches.push(`${day}: ${handle}: ${e.message}`);
        continue;
      }
      const cur = li.originalUnitPriceSet.shopMoney.currencyCode;
      if (cur && cur !== (plan.currency ?? "CAD")) mismatches.push(`${day}: ${handle}: currency ${cur}, want ${plan.currency ?? "CAD"}`);
      got.set(handle, { units: li.currentQuantity, cents });
    }
    for (const p of plan.products) {
      const wantUnits = p.units[i];
      const g = got.get(p.handle);
      if (wantUnits === 0) {
        if (g) mismatches.push(`${day}: ${p.handle}: store has ${g.units} units, plan has none that day`);
        continue;
      }
      if (!g) {
        mismatches.push(`${day}: ${p.handle}: missing line (plan: ${wantUnits} units at ${p.prices[i]})`);
        continue;
      }
      if (g.units !== wantUnits) mismatches.push(`${day}: ${p.handle}: units ${g.units}, plan ${wantUnits}`);
      if (g.cents !== p.prices[i]) mismatches.push(`${day}: ${p.handle}: price ${g.cents} cents, plan ${p.prices[i]}`);
    }
    if (mismatches.length === before) matchedDays++;
  });
  return { mismatches, ignored, seededDays, matchedDays };
}

const ORDERS_QUERY = `query($q: String!, $after: String) {
  orders(first: 25, query: $q, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name processedAt tags
      lineItems(first: 20) {
        pageInfo { hasNextPage }
        nodes { currentQuantity variant { id } originalUnitPriceSet { shopMoney { amount currencyCode } } }
      }
    }
  }
}`;

export async function fetchSeededOrders(store) {
  const all = [];
  let after = null;
  for (;;) {
    const data = await withRetry("read orders", async () => gql(store, ORDERS_QUERY, { q: `tag:${TAG_SYNTHETIC}`, after }), { baseMs: 5000 });
    const page = data.orders;
    for (const o of page.nodes) {
      if (o.lineItems.pageInfo.hasNextPage) throw new Error(`${o.name} has more than 20 lines; verify cannot read it fully`);
      all.push(o);
    }
    if (!page.pageInfo.hasNextPage) return all;
    after = page.pageInfo.endCursor;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { plan: "value", store: "value" });
  if (!args.store) throw new Error("usage: node seed/verify.mjs --plan seed/plan.json --store <shop>.myshopify.com");
  const plan = loadPlan(resolve(args.plan ?? `${SEED_DIR}/plan.json`));

  const orders = await fetchSeededOrders(args.store);
  const seedOrders = orders.filter((o) => (o.tags ?? []).some((t) => DAY_TAG_RE.test(t)));
  console.log(`read ${orders.length} orders tagged ${TAG_SYNTHETIC}; ${seedOrders.length} are seed orders`);
  if (orders.length > seedOrders.length) {
    console.log(`  ignoring ${orders.length - seedOrders.length} synthetic order(s) with no pp-seed-YYYY-MM-DD tag: ${orders.filter((o) => !seedOrders.includes(o)).map((o) => o.name).join(", ")}`);
  }
  if (seedOrders.length === 0) {
    console.log(`0 seeded days found (the plan has ${plan.history.dates.length}); nothing to compare yet. Run seed.mjs first.`);
    return 1;
  }

  if (!existsSync(STATE_FILE)) throw new Error(`${STATE_FILE} not found: it is written by seed.mjs and maps product handles to variant ids`);
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const variantToHandle = {};
  for (const [handle, v] of Object.entries(state)) variantToHandle[v.variantId] = handle;

  const r = compare(plan, seedOrders, variantToHandle);
  console.log(`${r.seededDays} of ${plan.history.dates.length} days seeded`);
  if (r.mismatches.length) {
    console.log(`\n${r.mismatches.length} mismatch(es):`);
    for (const m of r.mismatches.slice(0, 200)) console.log(`  ${m}`);
    if (r.mismatches.length > 200) console.log(`  ... and ${r.mismatches.length - 200} more`);
    return 1;
  }
  console.log(`${r.matchedDays} days x ${plan.products.length} products match the plan`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`verify: ${e.message}`);
      process.exit(2);
    },
  );
}
