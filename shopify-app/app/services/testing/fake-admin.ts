// An in-memory Shopify store that answers the Admin GraphQL queries and
// mutations the services send. No network. It never validates what the real
// API would accept beyond what the tests need.
import { formatCents } from "../money";
import type { AdminGraphql } from "../types";

export interface FakeVariant {
  id: string;
  title: string;
  sku: string;
  price: string; // decimal string, as Shopify sends it
  inventoryQuantity: number;
  cost: string | null;
  product: {
    id: string;
    title: string;
    handle: string;
    productType: string;
    tags: string[];
    status: string;
  };
}

export interface FakeLine {
  variantId: string | null;
  quantity: number;
  price: string;
  discounted?: string;
}

export interface FakeOrder {
  processedAt: string;
  tags: string[];
  cancelledAt?: string | null;
  lines: FakeLine[];
}

export class FakeAdmin {
  variants = new Map<string, FakeVariant>();
  orders: FakeOrder[] = [];
  /** Mutations received, in order: [variantId, price string]. */
  writes: { variantId: string; price: string }[] = [];
  mutationCalls = 0;
  /** Variants whose update comes back as a userError (and is not applied). */
  rejectWith = new Map<string, string>();
  /** Variants whose update reports success but does not change the price. */
  silentlyDrop = new Set<string>();
  /** Set to make every read fail. */
  failReads = false;

  addVariant(v: FakeVariant): void {
    this.variants.set(v.id, v);
  }

  priceCents(id: string): number {
    const p = this.variants.get(id)?.price as string;
    const [w, f = ""] = p.split(".");
    return Number(w) * 100 + Number(f.padEnd(2, "0").slice(0, 2));
  }

  /** Someone edits a price in the Shopify admin. */
  setPrice(id: string, price: string): void {
    (this.variants.get(id) as FakeVariant).price = price;
  }

  graphql: AdminGraphql = async (query, options) => {
    const vars = options?.variables ?? {};
    const respond = (data: unknown) => new Response(JSON.stringify({ data }));
    if (this.failReads && !query.includes("productVariantsBulkUpdate")) {
      return new Response(JSON.stringify({ errors: [{ message: "boom" }] }));
    }
    if (query.includes("PricePilotVariantPrices")) {
      const ids = vars.ids as string[];
      return respond({
        nodes: ids.map((id) => {
          const v = this.variants.get(id);
          return v ? { id: v.id, price: v.price } : null;
        }),
      });
    }
    if (query.includes("PricePilotVariants")) {
      const all = [...this.variants.values()];
      const first = vars.first as number;
      const start = vars.after ? Number(vars.after) : 0;
      const page = all.slice(start, start + first);
      return respond({
        productVariants: {
          pageInfo: {
            hasNextPage: start + first < all.length,
            endCursor: String(start + first),
          },
          nodes: page.map((v) => ({
            id: v.id,
            title: v.title,
            sku: v.sku,
            price: v.price,
            inventoryQuantity: v.inventoryQuantity,
            inventoryItem: { unitCost: v.cost === null ? null : { amount: v.cost } },
            product: v.product,
          })),
        },
      });
    }
    if (query.includes("PricePilotOrders")) {
      const since = String(vars.query).replace("processed_at:>=", "");
      const matching = this.orders.filter((o) => o.processedAt.slice(0, 10) >= since);
      const first = vars.first as number;
      const start = vars.after ? Number(vars.after) : 0;
      const page = matching.slice(start, start + first);
      return respond({
        orders: {
          pageInfo: {
            hasNextPage: start + first < matching.length,
            endCursor: String(start + first),
          },
          nodes: page.map((o, i) => ({
            id: `gid://shopify/Order/${start + i}`,
            processedAt: o.processedAt,
            cancelledAt: o.cancelledAt ?? null,
            tags: o.tags,
            lineItems: {
              pageInfo: { hasNextPage: false },
              nodes: o.lines.map((l) => ({
                currentQuantity: l.quantity,
                variant: l.variantId ? { id: l.variantId } : null,
                originalUnitPriceSet: { shopMoney: { amount: l.price } },
                discountedUnitPriceAfterAllDiscountsSet: {
                  shopMoney: { amount: l.discounted ?? l.price },
                },
              })),
            },
          })),
        },
      });
    }
    if (query.includes("productVariantsBulkUpdate")) {
      this.mutationCalls++;
      const inputs = vars.variants as { id: string; price: string }[];
      const updated: { id: string; price: string }[] = [];
      const userErrors: { field: string[]; message: string }[] = [];
      inputs.forEach((input, idx) => {
        const reject = this.rejectWith.get(input.id);
        if (reject) {
          userErrors.push({ field: ["variants", String(idx), "price"], message: reject });
          return;
        }
        this.writes.push({ variantId: input.id, price: input.price });
        const v = this.variants.get(input.id);
        if (!v) {
          userErrors.push({ field: ["variants", String(idx), "id"], message: "Variant does not exist" });
          return;
        }
        if (!this.silentlyDrop.has(input.id)) v.price = input.price;
        updated.push({ id: input.id, price: v.price });
      });
      return respond({ productVariantsBulkUpdate: { productVariants: updated, userErrors } });
    }
    throw new Error(`FakeAdmin: unrecognised request: ${query.slice(0, 80)}`);
  };
}

/** A deterministic PRNG so synthetic histories are reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export const DAY_MS = 86_400_000;

/** ISO timestamp at 12:00 UTC, `daysAgo` UTC days before today. */
export function daysAgoIso(daysAgo: number): string {
  const today = Math.floor(Date.now() / DAY_MS);
  return new Date((today - daysAgo) * DAY_MS + 12 * 3_600_000).toISOString();
}

export interface HistorySpec {
  variantId: string;
  /** price in cents for a given day index counted from the oldest day (0..99) */
  priceAt: (i: number) => number;
  baseUnits: number;
  elasticity: number;
  refPrice: number;
  seed: number;
  tags?: string[];
}

/**
 * Adds one order per sale day with a units count following a constant
 * elasticity curve plus noise. This is test data, not pricing logic.
 */
export function addHistory(admin: FakeAdmin, spec: HistorySpec, days = 100): void {
  const rand = rng(spec.seed);
  for (let i = 0; i < days; i++) {
    const price = spec.priceAt(i);
    const mean = spec.baseUnits * Math.pow(price / spec.refPrice, spec.elasticity);
    const units = Math.max(1, Math.round(mean * (0.9 + 0.2 * rand())));
    admin.orders.push({
      processedAt: daysAgoIso(days - i),
      tags: spec.tags ?? [],
      lines: [{ variantId: spec.variantId, quantity: units, price: formatCents(price) }],
    });
  }
}
