#!/usr/bin/env node
// Seeds a Shopify development store with the SYNTHETIC catalog and order
// history in plan.json. See README.md.
//
//   node seed/seed.mjs --plan seed/plan.json --store <shop>.myshopify.com [--dry-run] [--products-only] [--days N]
//
// Idempotent: products are found by handle, and each day's order is found by
// its pp-seed-YYYY-MM-DD tag before it is created.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SEED_DIR, STATE_FILE, TAG_PRODUCT, TAG_SYNTHETIC, centsToMoney, checkUserErrors, dayTag, gql, loadPlan, moneyToCents, parseArgs, sleep,
  withRetry,
} from "./lib.mjs";

const ORDER_INTERVAL_MS = 13000; // dev stores allow 5 orderCreate a minute

const Q_PRODUCT = `query($q: String!) {
  products(first: 5, query: $q) {
    nodes {
      id handle tags
      variants(first: 5) { nodes { id price sku inventoryItem { id sku unitCost { amount } } } }
    }
  }
}`;

const M_PRODUCT_CREATE = `mutation($product: ProductCreateInput!) {
  productCreate(product: $product) {
    product { id handle variants(first: 1) { nodes { id } } }
    userErrors { field message }
  }
}`;

const M_VARIANT_UPDATE = `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price inventoryItem { sku unitCost { amount } } }
    userErrors { field message }
  }
}`;

const Q_DAY_ORDER = `query($q: String!) { orders(first: 5, query: $q) { nodes { id name tags } } }`;

const Q_SEEDED = `query($after: String) {
  orders(first: 50, query: "tag:pricepilot-synthetic", after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id name tags }
  }
}`;

const M_ORDER_CREATE = `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    order { id name processedAt }
    userErrors { field message }
  }
}`;

function show(label, query, variables) {
  console.log(`\n--- would send: ${label} ---`);
  console.log(query.replace(/\n\s*/g, " "));
  console.log(JSON.stringify(variables, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { plan: "value", store: "value", "dry-run": "boolean", "products-only": "boolean", days: "value" });
  if (!args.store) throw new Error("usage: node seed/seed.mjs --plan seed/plan.json --store <shop>.myshopify.com [--dry-run] [--products-only] [--days N]");
  const store = args.store;
  const dry = !!args["dry-run"];
  const plan = loadPlan(resolve(args.plan ?? `${SEED_DIR}/plan.json`));
  const currency = plan.currency ?? "CAD";
  const nDays = args.days === undefined ? plan.history.dates.length : Number(args.days);
  if (!Number.isInteger(nDays) || nDays < 1 || nDays > plan.history.dates.length) throw new Error(`--days must be an integer from 1 to ${plan.history.dates.length}`);

  console.log(`${dry ? "DRY RUN (no mutation is sent)" : "LIVE RUN"}: SYNTHETIC data, store ${store}, ${plan.products.length} products, ${nDays} of ${plan.history.dates.length} days`);

  // ---- products ------------------------------------------------------------
  const state = {};
  const productMutations = [];
  let unchanged = 0;

  for (const p of plan.products) {
    const found = (await withRetry(`look up ${p.handle}`, async () => gql(store, Q_PRODUCT, { q: `handle:${p.handle}` }), { baseMs: 5000 })).products.nodes.find((n) => n.handle === p.handle);

    let productId = found?.id;
    let variant = found?.variants.nodes[0];
    if (!found) {
      const input = { title: p.title, handle: p.handle, productType: p.product_type, tags: [...p.tags, TAG_PRODUCT] };
      productMutations.push({ kind: "productCreate", handle: p.handle, query: M_PRODUCT_CREATE, variables: { product: input } });
      if (!dry) {
        const d = await withRetry(`create ${p.handle}`, async () => {
          const r = gql(store, M_PRODUCT_CREATE, { product: input });
          checkUserErrors(`productCreate ${p.handle}`, r);
          return r;
        });
        productId = d.productCreate.product.id;
        variant = { id: d.productCreate.product.variants.nodes[0].id, price: "0.00", sku: null, inventoryItem: { sku: null, unitCost: null } };
      }
    }

    // Price, unit cost and sku on the single variant. The cost is omitted for
    // the product that deliberately has none.
    const want = { price: centsToMoney(p.price_cents), sku: p.sku, cost: p.unit_cost_cents == null ? null : centsToMoney(p.unit_cost_cents) };
    const have = variant && {
      price: variant.price,
      sku: variant.inventoryItem?.sku ?? variant.sku ?? null,
      cost: variant.inventoryItem?.unitCost?.amount ?? null,
    };
    const same =
      have &&
      moneyToCents(have.price) === p.price_cents &&
      have.sku === want.sku &&
      (want.cost === null || (have.cost !== null && moneyToCents(have.cost) === p.unit_cost_cents));
    if (same) {
      unchanged++;
    } else {
      const inventoryItem = { sku: want.sku };
      if (want.cost !== null) inventoryItem.cost = want.cost;
      const vars = { productId: productId ?? `<id of ${p.handle}, from productCreate>`, variants: [{ id: variant?.id ?? `<variant id of ${p.handle}, from productCreate>`, price: want.price, inventoryItem }] };
      productMutations.push({ kind: "productVariantsBulkUpdate", handle: p.handle, query: M_VARIANT_UPDATE, variables: vars });
      if (!dry) {
        await withRetry(`update variant ${p.handle}`, async () => {
          const r = gql(store, M_VARIANT_UPDATE, vars);
          checkUserErrors(`productVariantsBulkUpdate ${p.handle}`, r);
          return r;
        });
      }
    }
    state[p.handle] = { productId: productId ?? `<product id of ${p.handle}, assigned by productCreate>`, variantId: variant?.id ?? `<variant id of ${p.handle}, assigned by productCreate>` };
    console.log(`  ${found ? "found  " : dry ? "missing" : "created"} ${p.handle}`);
  }

  console.log(`\nproducts: ${productMutations.filter((m) => m.kind === "productCreate").length} to create, ${productMutations.filter((m) => m.kind === "productVariantsBulkUpdate").length} variant updates, ${unchanged} already correct`);
  if (dry) {
    productMutations.slice(0, 2).forEach((m, i) => show(`product mutation ${i + 1}/${productMutations.length}: ${m.kind} ${m.handle}`, m.query, m.variables));
    if (productMutations.length > 2) console.log(`\n... and ${productMutations.length - 2} more product mutations (${summariseKinds(productMutations.slice(2))})`);
  } else {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
    console.log(`wrote ${STATE_FILE}`);
  }

  if (args["products-only"]) {
    console.log(dry ? "\ndry run complete (--products-only)." : "\nproducts done (--products-only).");
    return;
  }

  // ---- orders --------------------------------------------------------------
  const dates = plan.history.dates.slice(0, nDays);
  const orderMutations = [];
  let existing = 0;
  let created = 0;

  // One bulk read up front (days already in the store are skipped without a
  // call each); a day not found there is still checked by its own tag right
  // before it is created.
  const known = new Map();
  for (let after = null; ; ) {
    const page = (await withRetry("list seeded orders", async () => gql(store, Q_SEEDED, { after }), { baseMs: 5000 })).orders;
    for (const o of page.nodes) for (const t of o.tags) if (/^pp-seed-\d{4}-\d{2}-\d{2}$/.test(t)) known.set(t, o);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }

  const dayExists = async (date) => {
    const r = await withRetry(`look up order ${date}`, async () => gql(store, Q_DAY_ORDER, { q: `tag:${dayTag(date)}` }), { baseMs: 5000 });
    return r.orders.nodes.find((o) => o.tags.includes(dayTag(date)));
  };

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const label = `day ${i + 1}/${dates.length}`;
    const already = known.get(dayTag(date)) ?? (dry ? undefined : await dayExists(date));
    if (already) {
      existing++;
      console.log(`${label} exists ${already.name} (${date}), skipped`);
      continue;
    }

    const lineItems = [];
    for (const p of plan.products) {
      if (p.units[i] > 0) {
        lineItems.push({
          variantId: state[p.handle].variantId,
          quantity: p.units[i],
          priceSet: { shopMoney: { amount: centsToMoney(p.prices[i]), currencyCode: currency } },
        });
      }
    }
    // One order per day, no customer, no email. Tags mark it synthetic and
    // carry the day, which is what makes a re-run safe.
    const vars = {
      order: { currency, processedAt: `${date}T15:00:00Z`, tags: [TAG_SYNTHETIC, dayTag(date)], financialStatus: "PAID", lineItems },
      options: { inventoryBehaviour: "BYPASS", sendReceipt: false, sendFulfillmentReceipt: false },
    };
    orderMutations.push({ kind: "orderCreate", date, query: M_ORDER_CREATE, variables: vars, lines: lineItems.length });

    if (dry) continue;

    const res = await withRetry(
      `create order ${date}`,
      async () => {
        const r = gql(store, M_ORDER_CREATE, vars);
        checkUserErrors(`orderCreate ${date}`, r);
        return r.orderCreate.order;
      },
      // A call that "failed" may still have created the order: look first.
      { beforeRetry: async () => (await dayExists(date)) ?? undefined },
    );
    created++;
    console.log(`${label} created ${res.name} (${date}, ${lineItems.length} lines)`);
    if (i < dates.length - 1) await sleep(ORDER_INTERVAL_MS);
  }

  if (dry) {
    console.log(`\norders: ${orderMutations.length} to create, ${existing} already in the store`);
    orderMutations.slice(0, 2).forEach((m, i) => show(`order mutation ${i + 1}/${orderMutations.length}: orderCreate ${m.date} (${m.lines} lines)`, m.query, m.variables));
    if (orderMutations.length > 2) console.log(`\n... and ${orderMutations.length - 2} more orderCreate mutations`);
    const secs = orderMutations.length * (ORDER_INTERVAL_MS / 1000);
    console.log(`\nTOTAL that a live run would send: ${productMutations.length} product mutations, ${orderMutations.length} orderCreate (about ${Math.ceil(secs / 60)} minutes at 13 s each). Sent: 0.`);
    console.log("dry run complete.");
  } else {
    console.log(`\ndone: ${created} orders created, ${existing} already existed. Now run: node seed/verify.mjs --plan seed/plan.json --store ${store}`);
  }
}

function summariseKinds(ms) {
  const c = {};
  for (const m of ms) c[m.kind] = (c[m.kind] ?? 0) + 1;
  return Object.entries(c).map(([k, n]) => `${n} ${k}`).join(", ");
}

main().catch((e) => {
  console.error(`\nseed failed: ${e.message}`);
  console.error("Nothing is lost: re-running skips every product and day already in the store.");
  process.exit(1);
});
