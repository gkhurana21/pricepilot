// The functions the screens call. Routes import ONLY from this file and from
// ./types; everything else under services/ is an implementation detail.
//
// Hard rule: TypeScript never computes or adjusts a price. Estimates,
// proposals and decisions come from the Go engine (engine.server.ts); this
// file reads, aggregates, stores, and writes the engine's final_price to
// Shopify. No order rows or customer data are stored: orders are aggregated in
// memory and only the per-SKU estimate/decision summary is kept.

import prisma from "../db.server";
import {
  DEFAULT_ORDER_WINDOW_DAYS,
  fetchLivePrices,
  fetchOrders,
  fetchVariants,
  writePrices,
} from "./catalog.server";
import type { CatalogVariant, PriceWrite } from "./catalog.server";
import { decide, estimate } from "./engine.server";
import type { EstimateSku } from "./engine.server";
import { buildObservations, dayIndex, dayToDate } from "./observations";
import { loadTrueElasticities } from "./plan.server";
import { getPolicy as loadPolicy } from "./policy.server";
import { decidingRule, outcomeOf } from "./rows";
import type {
  AdminGraphql,
  DataBasis,
  Decision,
  FitOptions,
  Policy,
  Proposal,
  ReviewRow,
  RunListItem,
  RunStatus,
  RunView,
  SKUState,
  Summary,
  WriteItem,
  WriteReport,
} from "./types";

const PROBE_TAG = "pricepilot-probe";
const NEVER = "0001-01-01T00:00:00Z";
const MS_PER_DAY = 86_400_000;

// Run.status is a plain string column. Two transient values exist only in the
// database while a write is in flight; the screens see them as PARTIAL.
type StoredStatus = RunStatus | "APPLYING" | "ROLLING_BACK";

function viewStatus(status: string): RunStatus {
  if (status === "APPLYING" || status === "ROLLING_BACK") return "PARTIAL";
  return status as RunStatus;
}

interface RunRecord {
  id: string;
  shop: string;
  createdAt: Date;
  status: string;
  policyJson: string;
  policyHash: string;
  optionsJson: string;
  dataBasisJson: string;
  summaryJson: string;
  rowsJson: string;
  applyJson: string | null;
  rollbackJson: string | null;
  rolledBackAt: Date | null;
}

function toView(r: RunRecord): RunView {
  return {
    id: r.id,
    shop: r.shop,
    createdAt: r.createdAt.toISOString(),
    status: viewStatus(r.status),
    policy: JSON.parse(r.policyJson) as Policy,
    policyHash: r.policyHash,
    options: JSON.parse(r.optionsJson) as FitOptions,
    dataBasis: JSON.parse(r.dataBasisJson) as DataBasis,
    summary: JSON.parse(r.summaryJson) as Summary,
    rows: JSON.parse(r.rowsJson) as ReviewRow[],
    apply: r.applyJson ? (JSON.parse(r.applyJson) as WriteReport) : null,
    rollback: r.rollbackJson ? (JSON.parse(r.rollbackJson) as WriteReport) : null,
  };
}

async function loadRecord(shop: string, runId: string): Promise<RunRecord | null> {
  return prisma.run.findFirst({ where: { id: runId, shop } });
}

/** The policy in force for a shop, and its hash as computed by the Go engine. */
export async function getPolicy(
  shop: string,
): Promise<{ policy: Policy; policyHash: string }> {
  return loadPolicy(shop);
}

/** The most recent run for a shop, or null if there has never been one. */
export async function getLatestRun(shop: string): Promise<RunView | null> {
  const record = await prisma.run.findFirst({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });
  return record ? toView(record) : null;
}

/** One run by id, or null if it does not exist for this shop. */
export async function getRun(
  shop: string,
  runId: string,
): Promise<RunView | null> {
  const record = await loadRecord(shop, runId);
  return record ? toView(record) : null;
}

// ---- createRun -------------------------------------------------------------

function variantTitle(v: CatalogVariant): string {
  return v.title && v.title !== "Default Title"
    ? `${v.product.title} — ${v.title}`
    : v.product.title;
}

/** The price log feeds the engine's velocity rules: Shopify keeps no price history. */
async function velocityFacts(
  shop: string,
  windowDays: number,
  now: Date,
): Promise<Map<string, { last: Date; inWindow: number }>> {
  const changes = await prisma.priceChange.findMany({
    where: { shop },
    select: { variantId: true, at: true },
  });
  const windowStart = now.getTime() - windowDays * MS_PER_DAY;
  const facts = new Map<string, { last: Date; inWindow: number }>();
  for (const c of changes) {
    const f = facts.get(c.variantId) ?? { last: c.at, inWindow: 0 };
    if (c.at > f.last) f.last = c.at;
    if (c.at.getTime() >= windowStart) f.inWindow++;
    facts.set(c.variantId, f);
  }
  return facts;
}

/**
 * Reads the catalog and order history, asks the engine for estimates,
 * proposals and decisions, and stores the result as a PREVIEW run. Writes
 * nothing to Shopify.
 */
export async function createRun(
  graphql: AdminGraphql,
  shop: string,
): Promise<RunView> {
  const { policy } = await loadPolicy(shop);
  const now = new Date();

  // Complete UTC days only: today is still in progress and would read as a
  // false zero-sales day.
  const endDay = dayIndex(now) - 1;
  const startDay = dayIndex(now) - DEFAULT_ORDER_WINDOW_DAYS;

  const [allVariants, orders] = await Promise.all([
    fetchVariants(graphql),
    fetchOrders(graphql, startDay),
  ]);
  const variants = allVariants.filter(
    (v) => v.product.status === "ACTIVE" && !v.product.tags.includes(PROBE_TAG),
  );

  const observations = buildObservations(orders.lines, { startDay, endDay });
  const velocity = await velocityFacts(shop, policy.velocity.window_days, now);

  const states = new Map<string, SKUState>();
  const estimateInput: EstimateSku[] = variants.map((v) => {
    const facts = velocity.get(v.id);
    const sku: SKUState = {
      id: v.id,
      variant_gid: v.id,
      current_price: v.priceCents,
      unit_cost: v.unitCostCents ?? 0,
      map_price: 0,
      tags: v.product.tags,
      collections: v.product.productType ? [v.product.productType] : [],
      last_price_change_at: facts ? facts.last.toISOString() : NEVER,
      changes_in_window: facts ? facts.inWindow : 0,
      inventory_quantity: v.inventoryQuantity ?? 0,
    };
    states.set(v.id, sku);
    return {
      sku,
      group: v.product.productType,
      observations: observations.get(v.id) ?? [],
    };
  });

  const estimated = await estimate(estimateInput);

  const proposals = new Map<string, Proposal>();
  for (const r of estimated.results) {
    if (r.proposal) proposals.set(r.sku_id, r.proposal);
  }
  const decided = await decide({
    policy,
    now: now.toISOString(),
    items: [...proposals].map(([id, proposal]) => ({
      sku: states.get(id) as SKUState,
      proposal,
    })),
  });
  const decisions = new Map(decided.decisions.map((d) => [d.sku_id, d]));

  const dataBasis = describeOrders(orders.lines, orders.orderCount, orders.allSynthetic);
  const truth = dataBasis.synthetic ? loadTrueElasticities() : null;
  const byId = new Map(variants.map((v) => [v.id, v]));

  const rows: ReviewRow[] = estimated.results.map((r) => {
    const v = byId.get(r.sku_id) as CatalogVariant;
    const decision = decisions.get(r.sku_id) ?? null;
    const trueElasticity =
      truth?.bySku.get(v.sku) ?? truth?.byHandle.get(v.product.handle) ?? null;
    return {
      skuId: r.sku_id,
      variantId: v.id,
      productId: v.product.id,
      title: variantTitle(v),
      sku: v.sku,
      group: v.product.productType,
      tags: v.product.tags,
      currentPrice: v.priceCents,
      unitCost: v.unitCostCents,
      estimate: r.estimate,
      trueElasticity: trueElasticity ?? null,
      proposal: r.proposal,
      noProposalReason: r.no_proposal_reason,
      noProposalCode: r.no_proposal_code,
      decision,
      outcome: decision ? outcomeOf(decision) : "no_proposal",
      decidingRule: decision ? decidingRule(decision) : null,
    };
  });

  const record = await prisma.run.create({
    data: {
      shop,
      status: "PREVIEW",
      policyJson: JSON.stringify(policy),
      policyHash: decided.policy_hash,
      optionsJson: JSON.stringify(estimated.options),
      dataBasisJson: JSON.stringify(dataBasis),
      summaryJson: JSON.stringify(decided.summary),
      rowsJson: JSON.stringify(rows),
    },
  });
  return toView(record);
}

function describeOrders(
  lines: { processedAt: string }[],
  orderCount: number,
  synthetic: boolean,
): DataBasis {
  if (lines.length === 0) {
    return { synthetic, orderCount, firstDay: null, lastDay: null, days: 0 };
  }
  let first = Infinity;
  let last = -Infinity;
  for (const l of lines) {
    const d = dayIndex(l.processedAt);
    if (d < first) first = d;
    if (d > last) last = d;
  }
  return {
    synthetic,
    orderCount,
    firstDay: dayToDate(first),
    lastDay: dayToDate(last),
    days: last - first + 1,
  };
}

// ---- applyRun / rollbackRun --------------------------------------------------

function isWritable(row: ReviewRow): row is ReviewRow & { decision: Decision } {
  const d = row.decision;
  return (
    d !== null &&
    (d.action === "approve" || d.action === "clamp") &&
    d.final_price !== d.current_price
  );
}

function report(items: WriteItem[], attempted: number): WriteReport {
  return {
    at: new Date().toISOString(),
    attempted,
    applied: items.filter((i) => i.status === "applied").length,
    skipped: items.filter((i) => i.status === "stale_price" || i.status === "edited_since_apply").length,
    failed: items.filter((i) => i.status === "api_error").length,
    verified: items.filter((i) => i.verified).length,
    items,
  };
}

async function setStatus(id: string, status: StoredStatus): Promise<void> {
  await prisma.run.update({ where: { id }, data: { status } });
}

/**
 * Applies a PREVIEW run: re-reads live prices, skips variants whose price
 * moved since the decision, writes the rest, then re-reads to verify.
 */
export async function applyRun(
  graphql: AdminGraphql,
  shop: string,
  runId: string,
): Promise<RunView> {
  const record = await loadRecord(shop, runId);
  if (!record) throw new Error("Run not found");
  if (record.status !== "PREVIEW") {
    throw new Error(`Only a preview can be applied; this run is ${viewStatus(record.status)}.`);
  }
  const rows = (JSON.parse(record.rowsJson) as ReviewRow[]).filter(isWritable);
  if (rows.length === 0) {
    throw new Error("This run has no price changes to apply.");
  }

  // Claim the run and persist "in progress" before the first write, so a second
  // click or a crash can never apply the same preview twice.
  const claimed = await prisma.run.updateMany({
    where: { id: runId, shop, status: "PREVIEW" },
    data: { status: "APPLYING" },
  });
  if (claimed.count !== 1) {
    throw new Error("This run is already being applied or has been applied.");
  }

  let wroteAnything = false;
  try {
    const live = await fetchLivePrices(graphql, rows.map((r) => r.variantId));

    const items: WriteItem[] = [];
    const itemFor = new Map<string, WriteItem>();
    const writes: PriceWrite[] = [];
    for (const row of rows) {
      const d = row.decision as Decision;
      const price = live.get(row.variantId);
      const item: WriteItem = {
        skuId: row.skuId,
        title: row.title,
        fromPrice: d.current_price,
        toPrice: d.final_price,
        status: "applied",
        error: null,
        livePriceAfter: null,
        verified: false,
      };
      if (price === undefined) {
        item.status = "api_error";
        item.error = "The variant no longer exists in Shopify.";
      } else if (price !== d.current_price) {
        item.status = "stale_price";
        item.error = `Live price is ${price} cents; the decision was made against ${d.current_price}.`;
        item.livePriceAfter = price;
      } else {
        writes.push({ variantId: row.variantId, productId: row.productId, priceCents: d.final_price });
      }
      items.push(item);
      itemFor.set(row.variantId, item);
    }

    wroteAnything = writes.length > 0;
    const outcomes = await writePrices(graphql, writes, async (chunk) => {
      for (const [variantId, outcome] of chunk) {
        const item = itemFor.get(variantId) as WriteItem;
        if (!outcome.ok) {
          item.status = "api_error";
          item.error = outcome.error;
        }
      }
      // Progress survives a crash mid-run: whatever was applied is on record.
      await prisma.run.update({
        where: { id: runId },
        data: { applyJson: JSON.stringify(report(items, rows.length)) },
      });
    });

    // Verify by reading Shopify back, not by trusting the mutation response.
    if (outcomes.size > 0) {
      try {
        const after = await fetchLivePrices(graphql, [...outcomes.keys()]);
        for (const variantId of outcomes.keys()) {
          const item = itemFor.get(variantId) as WriteItem;
          const price = after.get(variantId);
          item.livePriceAfter = price ?? null;
          item.verified = price === item.toPrice;
        }
      } catch {
        // Re-read failed: leave livePriceAfter null and verified false.
      }
    }

    const at = new Date();
    const logged = items.filter(
      (i) => i.status === "applied" && i.livePriceAfter !== i.fromPrice,
    );
    if (logged.length > 0) {
      await prisma.priceChange.createMany({
        data: logged.map((i) => ({
          shop,
          variantId: i.skuId,
          at,
          fromCents: i.fromPrice,
          toCents: i.toPrice,
          runId,
          kind: "apply",
        })),
      });
    }

    const final = report(items, rows.length);
    const status: RunStatus =
      final.applied === 0
        ? "FAILED"
        : final.applied === final.attempted && final.verified === final.applied
          ? "APPLIED"
          : "PARTIAL";
    const saved = await prisma.run.update({
      where: { id: runId },
      data: { status, applyJson: JSON.stringify(final) },
    });
    return toView(saved);
  } catch (error) {
    // Nothing reached Shopify: the preview is still a valid preview.
    if (!wroteAnything) await setStatus(runId, "PREVIEW");
    throw error;
  }
}

/**
 * Restores every variant the run changed to its prior price, skipping any
 * whose live price is no longer the price the run applied, then re-reads.
 */
export async function rollbackRun(
  graphql: AdminGraphql,
  shop: string,
  runId: string,
): Promise<RunView> {
  const record = await loadRecord(shop, runId);
  if (!record) throw new Error("Run not found");
  if (record.rolledBackAt || (record.status !== "APPLIED" && record.status !== "PARTIAL")) {
    throw new Error(
      `Only an applied run that has not been rolled back can be rolled back; this run is ${viewStatus(record.status)}.`,
    );
  }
  const applied = (record.applyJson
    ? (JSON.parse(record.applyJson) as WriteReport).items
    : []
  ).filter((i) => i.status === "applied");
  if (applied.length === 0) throw new Error("This run applied no price changes to roll back.");

  const previous = record.status;
  const claimed = await prisma.run.updateMany({
    where: { id: runId, shop, status: previous, rolledBackAt: null },
    data: { status: "ROLLING_BACK" },
  });
  if (claimed.count !== 1) throw new Error("This run is already being rolled back.");

  const productOf = new Map(
    (JSON.parse(record.rowsJson) as ReviewRow[]).map((r) => [r.skuId, r.productId]),
  );
  let wroteAnything = false;
  try {
    const live = await fetchLivePrices(graphql, applied.map((i) => i.skuId));

    // From the rollback's point of view: it moves the price from what the run
    // applied back to what the run replaced.
    const items: WriteItem[] = [];
    const itemFor = new Map<string, WriteItem>();
    const writes: PriceWrite[] = [];
    for (const original of applied) {
      const price = live.get(original.skuId);
      const item: WriteItem = {
        skuId: original.skuId,
        title: original.title,
        fromPrice: original.toPrice,
        toPrice: original.fromPrice,
        status: "applied",
        error: null,
        livePriceAfter: null,
        verified: false,
      };
      const productId = productOf.get(original.skuId);
      if (price === undefined || !productId) {
        item.status = "api_error";
        item.error = "The variant no longer exists in Shopify.";
      } else if (price !== original.toPrice) {
        item.status = "edited_since_apply";
        item.error = `Live price is ${price} cents, not the ${original.toPrice} this run applied; left alone.`;
        item.livePriceAfter = price;
      } else {
        writes.push({ variantId: original.skuId, productId, priceCents: original.fromPrice });
      }
      items.push(item);
      itemFor.set(original.skuId, item);
    }

    wroteAnything = writes.length > 0;
    const outcomes = await writePrices(graphql, writes, (chunk) => {
      for (const [variantId, outcome] of chunk) {
        if (!outcome.ok) {
          const item = itemFor.get(variantId) as WriteItem;
          item.status = "api_error";
          item.error = outcome.error;
        }
      }
    });

    if (outcomes.size > 0) {
      try {
        const after = await fetchLivePrices(graphql, [...outcomes.keys()]);
        for (const variantId of outcomes.keys()) {
          const item = itemFor.get(variantId) as WriteItem;
          const price = after.get(variantId);
          item.livePriceAfter = price ?? null;
          item.verified = price === item.toPrice;
        }
      } catch {
        // Re-read failed: leave livePriceAfter null and verified false.
      }
    }

    // Rollbacks are price changes too, so they count toward velocity.
    const at = new Date();
    const logged = items.filter(
      (i) => i.status === "applied" && i.livePriceAfter !== i.fromPrice,
    );
    if (logged.length > 0) {
      await prisma.priceChange.createMany({
        data: logged.map((i) => ({
          shop,
          variantId: i.skuId,
          at,
          fromCents: i.fromPrice,
          toCents: i.toPrice,
          runId,
          kind: "rollback",
        })),
      });
    }

    const final = report(items, applied.length);
    const status: RunStatus =
      final.applied === final.attempted && final.verified === final.applied
        ? "ROLLED_BACK"
        : "ROLLBACK_PARTIAL";
    const saved = await prisma.run.update({
      where: { id: runId },
      data: { status, rollbackJson: JSON.stringify(final), rolledBackAt: at },
    });
    return toView(saved);
  } catch (error) {
    if (!wroteAnything) await setStatus(runId, previous as StoredStatus);
    throw error;
  }
}

/** Runs for a shop, newest first. */
export async function listRuns(shop: string): Promise<RunListItem[]> {
  const records = await prisma.run.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      createdAt: true,
      status: true,
      policyJson: true,
      policyHash: true,
      summaryJson: true,
      applyJson: true,
      rolledBackAt: true,
    },
  });
  return records.map((r) => {
    const policy = JSON.parse(r.policyJson) as Policy;
    const summary = JSON.parse(r.summaryJson) as Summary;
    const apply = r.applyJson ? (JSON.parse(r.applyJson) as WriteReport) : null;
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      status: viewStatus(r.status),
      policyId: policy.id,
      policyVersion: policy.version,
      policyHash: r.policyHash,
      proposals: summary.total,
      approved: summary.approved,
      adjusted: summary.clamped,
      heldBack: summary.rejected,
      applied: apply?.applied ?? 0,
      rolledBackAt: r.rolledBackAt ? r.rolledBackAt.toISOString() : null,
    };
  });
}
