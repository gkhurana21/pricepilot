// Admin GraphQL access: catalog and order reads, live price reads, and the
// chunked price write. Nothing here decides a price; the write sends only the
// final prices the engine produced.

import { dayIndex } from "./observations";
import type { OrderLine } from "./observations";
import { formatCents, toCents, toCentsTruncated } from "./money";
import type { AdminGraphql, Cents } from "./types";

export const SYNTHETIC_ORDER_TAG = "pricepilot-synthetic";

// Page sizes are set by the 1000-point cap on a single query's requested cost
// (connections cost their `first` times what they select). Orders carry up to
// 50 line items each, which is why an orders page is only a few orders.
const VARIANTS_PER_PAGE = 100;
const ORDERS_PER_PAGE = 3;
const LINES_PER_ORDER = 50;
const PRICE_LOOKUP_CHUNK = 100;
// productVariantsBulkUpdate accepts at most 250 variants per call.
export const VARIANTS_PER_MUTATION = 250;

export const DEFAULT_ORDER_WINDOW_DAYS = 100;

export interface CatalogVariant {
  id: string;
  title: string;
  sku: string;
  priceCents: Cents;
  inventoryQuantity: number | null;
  unitCostCents: Cents | null;
  product: {
    id: string;
    title: string;
    handle: string;
    productType: string;
    tags: string[];
    status: string;
  };
}

export interface OrdersRead {
  lines: OrderLine[];
  orderCount: number; // non-cancelled orders read
  /** true only if at least one order was read and all of them carry the synthetic tag */
  allSynthetic: boolean;
}

interface GqlResult<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: { throttleStatus?: { restoreRate?: number; currentlyAvailable?: number }; requestedQueryCost?: number } };
}

const MAX_THROTTLE_RETRIES = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs one query, waiting out Shopify's cost throttle, and throws on GraphQL errors. */
async function gql<T>(
  graphql: AdminGraphql,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await graphql(query, { variables });
    const body = (await response.json()) as GqlResult<T>;
    if (body.errors?.length) {
      const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled && attempt < MAX_THROTTLE_RETRIES) {
        const rate = body.extensions?.cost?.throttleStatus?.restoreRate ?? 50;
        const need = body.extensions?.cost?.requestedQueryCost ?? 500;
        await sleep(Math.min(5000, Math.ceil((need / rate) * 1000)));
        continue;
      }
      throw new Error(`Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    if (!body.data) throw new Error("Shopify GraphQL returned no data");
    return body.data;
  }
}

const VARIANTS_QUERY = `#graphql
  query PricePilotVariants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        sku
        price
        inventoryQuantity
        inventoryItem { unitCost { amount } }
        product { id title handle productType tags status }
      }
    }
  }`;

interface VariantsData {
  productVariants: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: {
      id: string;
      title: string;
      sku: string | null;
      price: string;
      inventoryQuantity: number | null;
      inventoryItem: { unitCost: { amount: string } | null } | null;
      product: {
        id: string;
        title: string;
        handle: string;
        productType: string;
        tags: string[];
        status: string;
      };
    }[];
  };
}

function safeCents(amount: string | null | undefined): Cents | null {
  if (amount == null) return null;
  try {
    return toCents(amount);
  } catch {
    return null;
  }
}

/** Every product variant in the store, with cost and product facts. */
export async function fetchVariants(graphql: AdminGraphql): Promise<CatalogVariant[]> {
  const out: CatalogVariant[] = [];
  let after: string | null = null;
  for (;;) {
    const data: VariantsData = await gql<VariantsData>(graphql, VARIANTS_QUERY, {
      first: VARIANTS_PER_PAGE,
      after,
    });
    for (const v of data.productVariants.nodes) {
      const price = safeCents(v.price);
      if (price === null) continue; // unreadable price: leave the variant alone
      out.push({
        id: v.id,
        title: v.title,
        sku: v.sku ?? "",
        priceCents: price,
        inventoryQuantity: v.inventoryQuantity,
        // A cost with sub-cent digits is treated as unknown rather than rounded.
        unitCostCents: safeCents(v.inventoryItem?.unitCost?.amount),
        product: v.product,
      });
    }
    if (!data.productVariants.pageInfo.hasNextPage) break;
    after = data.productVariants.pageInfo.endCursor;
  }
  return out;
}

const ORDERS_QUERY = `#graphql
  query PricePilotOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        processedAt
        cancelledAt
        tags
        lineItems(first: ${LINES_PER_ORDER}) {
          pageInfo { hasNextPage }
          nodes {
            currentQuantity
            variant { id }
            originalUnitPriceSet { shopMoney { amount } }
            discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
          }
        }
      }
    }
  }`;

interface OrdersData {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: {
      processedAt: string | null;
      cancelledAt: string | null;
      tags: string[];
      lineItems: {
        pageInfo: { hasNextPage: boolean };
        nodes: {
          currentQuantity: number;
          variant: { id: string } | null;
          originalUnitPriceSet: { shopMoney: { amount: string } };
          discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: string } };
        }[];
      };
    }[];
  };
}

/**
 * Orders processed on or after `sinceDay` (UTC day index), as order lines.
 * Cancelled orders and lines with no variant are skipped. The query asks for
 * no order id and no customer field (name, email, phone, address): only dates,
 * tags, and each line's variant, quantity and unit prices.
 */
export async function fetchOrders(
  graphql: AdminGraphql,
  sinceDay: number,
): Promise<OrdersRead> {
  const since = new Date(sinceDay * 86_400_000).toISOString().slice(0, 10);
  const lines: OrderLine[] = [];
  let orderCount = 0;
  let synthetic = 0;
  let after: string | null = null;

  for (;;) {
    const data: OrdersData = await gql<OrdersData>(graphql, ORDERS_QUERY, {
      first: ORDERS_PER_PAGE,
      after,
      query: `processed_at:>=${since}`,
    });
    for (const order of data.orders.nodes) {
      if (order.cancelledAt || !order.processedAt) continue;
      orderCount++;
      if (order.tags.includes(SYNTHETIC_ORDER_TAG)) synthetic++;
      if (order.lineItems.pageInfo.hasNextPage) {
        console.warn(`An order has more than ${LINES_PER_ORDER} line items; the extra lines are not read.`);
      }
      for (const li of order.lineItems.nodes) {
        if (!li.variant) continue;
        const original = safeCents(li.originalUnitPriceSet.shopMoney.amount);
        if (original === null) continue;
        let discounted: Cents;
        try {
          discounted = toCentsTruncated(li.discountedUnitPriceAfterAllDiscountsSet.shopMoney.amount);
        } catch {
          continue;
        }
        lines.push({
          variantId: li.variant.id,
          processedAt: order.processedAt,
          quantity: li.currentQuantity,
          unitPriceCents: original,
          discountedUnitPriceCents: discounted,
        });
      }
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }

  return { lines, orderCount, allSynthetic: orderCount > 0 && synthetic === orderCount };
}

/** Window helper: the UTC day index `days` before today. */
export function windowStartDay(now: Date, days = DEFAULT_ORDER_WINDOW_DAYS): number {
  return dayIndex(now) - days;
}

const PRICES_QUERY = `#graphql
  query PricePilotVariantPrices($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant { id price }
    }
  }`;

/**
 * Live prices for the given variants. A variant that no longer exists is
 * absent from the map. Throws if Shopify cannot be read.
 */
export async function fetchLivePrices(
  graphql: AdminGraphql,
  variantIds: string[],
): Promise<Map<string, Cents>> {
  const prices = new Map<string, Cents>();
  for (let i = 0; i < variantIds.length; i += PRICE_LOOKUP_CHUNK) {
    const ids = variantIds.slice(i, i + PRICE_LOOKUP_CHUNK);
    const data = await gql<{ nodes: ({ id: string; price: string } | null)[] }>(
      graphql,
      PRICES_QUERY,
      { ids },
    );
    for (const node of data.nodes) {
      if (!node?.id) continue;
      const cents = safeCents(node.price);
      if (cents !== null) prices.set(node.id, cents);
    }
  }
  return prices;
}

export interface PriceWrite {
  variantId: string;
  productId: string;
  priceCents: Cents;
}

export interface WriteOutcome {
  ok: boolean;
  error: string | null;
}

const UPDATE_MUTATION = `#graphql
  mutation PricePilotUpdatePrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: true) {
      productVariants { id price }
      userErrors { field message code }
    }
  }`;

interface UpdateData {
  productVariantsBulkUpdate: {
    productVariants: { id: string; price: string }[] | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

/**
 * Writes prices grouped by product in chunks of 250 with allowPartialUpdates,
 * and reports each variant's outcome from productVariants and userErrors. A
 * failed request marks that chunk's variants failed and carries on.
 * `onChunk` fires after each chunk so callers can persist progress.
 */
export async function writePrices(
  graphql: AdminGraphql,
  writes: PriceWrite[],
  onChunk?: (outcomes: Map<string, WriteOutcome>) => Promise<void> | void,
): Promise<Map<string, WriteOutcome>> {
  const outcomes = new Map<string, WriteOutcome>();
  const byProduct = new Map<string, PriceWrite[]>();
  for (const w of writes) {
    const group = byProduct.get(w.productId) ?? [];
    group.push(w);
    byProduct.set(w.productId, group);
  }

  for (const [productId, group] of byProduct) {
    for (let i = 0; i < group.length; i += VARIANTS_PER_MUTATION) {
      const chunk = group.slice(i, i + VARIANTS_PER_MUTATION);
      const chunkOutcomes = new Map<string, WriteOutcome>();
      try {
        const data = await gql<UpdateData>(graphql, UPDATE_MUTATION, {
          productId,
          variants: chunk.map((w) => ({ id: w.variantId, price: formatCents(w.priceCents) })),
        });
        const result = data.productVariantsBulkUpdate;
        const updated = new Set((result.productVariants ?? []).map((v) => v.id));
        // userErrors name the failing input by index: field ["variants","3","price"].
        const errorByIndex = new Map<number, string>();
        const general: string[] = [];
        for (const e of result.userErrors ?? []) {
          const idx = e.field?.[0] === "variants" ? Number(e.field[1]) : NaN;
          if (Number.isInteger(idx)) {
            errorByIndex.set(idx, [errorByIndex.get(idx), e.message].filter(Boolean).join("; "));
          } else {
            general.push(e.message);
          }
        }
        chunk.forEach((w, idx) => {
          if (updated.has(w.variantId)) {
            chunkOutcomes.set(w.variantId, { ok: true, error: null });
          } else {
            chunkOutcomes.set(w.variantId, {
              ok: false,
              error: errorByIndex.get(idx) || general.join("; ") || "Variant was not updated",
            });
          }
        });
      } catch (error) {
        for (const w of chunk) {
          chunkOutcomes.set(w.variantId, {
            ok: false,
            error: error instanceof Error ? error.message : "Request failed",
          });
        }
      }
      for (const [k, v] of chunkOutcomes) outcomes.set(k, v);
      await onChunk?.(chunkOutcomes);
    }
  }
  return outcomes;
}
