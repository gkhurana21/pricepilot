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
import { decidingRule, outcomeCounts, outcomeOf } from "./rows";
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
  WritePlan,
  WritePlanItem,
  WriteReport,
} from "./types";

const PROBE_TAG = "pricepilot-probe";
const NEVER = "0001-01-01T00:00:00Z";
const MS_PER_DAY = 86_400_000;

/**
 * A write (apply or rollback) with no sign of life for this long is treated as
 * interrupted rather than in flight. Generous on purpose: a heartbeat is
 * stored after every mutation chunk, and one chunk, throttle retries included,
 * takes seconds.
 */
export const WRITE_TIMEOUT_MS = 2 * 60_000;

type WritingStatus = "APPLYING" | "ROLLING_BACK";

function isWriting(status: string): status is WritingStatus {
  return status === "APPLYING" || status === "ROLLING_BACK";
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
  writeStartedAt: Date | null;
  writeHeartbeatAt: Date | null;
  writePlanJson: string | null;
}

function isInterrupted(
  r: Pick<RunRecord, "status" | "writeStartedAt" | "writeHeartbeatAt">,
  now = Date.now(),
): boolean {
  if (!isWriting(r.status)) return false;
  const alive = r.writeHeartbeatAt ?? r.writeStartedAt;
  // No timestamp at all means the status predates the write journal: nothing
  // can still be running that write.
  return !alive || now - alive.getTime() > WRITE_TIMEOUT_MS;
}

function parseRows(rowsJson: string): ReviewRow[] {
  // The group is re-derived from the stored decision, so a run stored before
  // the current grouping reads exactly like a new one.
  return (JSON.parse(rowsJson) as ReviewRow[]).map((r) => ({
    ...r,
    outcome: r.decision ? outcomeOf(r.decision) : "no_proposal",
  }));
}

function toView(r: RunRecord): RunView {
  return {
    id: r.id,
    shop: r.shop,
    createdAt: r.createdAt.toISOString(),
    status: r.status as RunStatus,
    policy: JSON.parse(r.policyJson) as Policy,
    policyHash: r.policyHash,
    options: JSON.parse(r.optionsJson) as FitOptions,
    dataBasis: JSON.parse(r.dataBasisJson) as DataBasis,
    summary: JSON.parse(r.summaryJson) as Summary,
    rows: parseRows(r.rowsJson),
    apply: r.applyJson ? (JSON.parse(r.applyJson) as WriteReport) : null,
    rollback: r.rollbackJson ? (JSON.parse(r.rollbackJson) as WriteReport) : null,
    writeStartedAt: r.writeStartedAt ? r.writeStartedAt.toISOString() : null,
    interrupted: isInterrupted(r),
  };
}

/** Plain words for a status in an error message. */
function describeStatus(status: string): string {
  switch (status) {
    case "PREVIEW":
      return "a preview that has not been applied";
    case "APPLYING":
      return "being applied";
    case "APPLIED":
      return "already applied";
    case "PARTIAL":
      return "partly applied";
    case "FAILED":
      return "a failed apply that changed nothing";
    case "ROLLING_BACK":
      return "being rolled back";
    case "ROLLED_BACK":
      return "already rolled back";
    case "ROLLBACK_PARTIAL":
      return "partly rolled back";
    default:
      return status;
  }
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

/**
 * The shop's run whose write is in flight or was interrupted, if any. The
 * review screen shows it before anything else: until it is reconciled, prices
 * on Shopify may be partly changed and the price-change log is incomplete.
 */
export async function findUnfinishedWrite(shop: string): Promise<RunView | null> {
  const record = await prisma.run.findFirst({
    where: { shop, status: { in: ["APPLYING", "ROLLING_BACK"] } },
    orderBy: { createdAt: "desc" },
  });
  return record ? toView(record) : null;
}

async function assertNoUnfinishedWrite(shop: string): Promise<void> {
  const unfinished = await findUnfinishedWrite(shop);
  if (!unfinished) return;
  throw new Error(
    unfinished.interrupted
      ? "A write to Shopify was interrupted. Check what was written before starting anything else."
      : "A write to Shopify is in progress. Wait for it to finish.",
  );
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
  // An unfinished write means the price-change log the velocity rules read
  // is incomplete, so no new decision is made until it is reconciled.
  await assertNoUnfinishedWrite(shop);
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

// ---- applyRun / rollbackRun / recoverRun -----------------------------------
//
// Every write follows the same journal, so a process that dies part-way never
// leaves a run that nobody can explain or undo:
//
//   1. claim    status PREVIEW/APPLIED/... -> APPLYING or ROLLING_BACK, with
//               writeStartedAt and a heartbeat (atomic: a second click loses)
//   2. plan     read live prices, decide per variant what to send, and store
//               that plan before the first mutation
//   3. write    send the mutations; refresh the heartbeat after every chunk
//   4. finish   in one transaction: the report, the final status, and the
//               price-change log rows (never twice for the same variant)
//
// If the process dies between 2 and 4, the status stays APPLYING/ROLLING_BACK
// and the heartbeat goes stale. recoverRun then re-reads every planned variant
// and rebuilds the report from what Shopify shows, not from what was hoped.

function isWritable(row: ReviewRow): row is ReviewRow & { decision: Decision } {
  const d = row.decision;
  return (
    d !== null &&
    (d.action === "approve" || d.action === "clamp") &&
    d.final_price !== d.current_price
  );
}

function buildReport(
  items: WriteItem[],
  attempted: number,
  order: string[],
  recovered = false,
): WriteReport {
  const rank = new Map(order.map((id, i) => [id, i]));
  const sorted = [...items].sort(
    (a, b) => (rank.get(a.skuId) ?? Infinity) - (rank.get(b.skuId) ?? Infinity),
  );
  return {
    at: new Date().toISOString(),
    attempted,
    applied: sorted.filter((i) => i.status === "applied").length,
    skipped: sorted.filter((i) => i.status === "stale_price" || i.status === "edited_since_apply").length,
    failed: sorted.filter((i) => i.status === "api_error" || i.status === "not_written").length,
    verified: sorted.filter((i) => i.verified).length,
    items: sorted,
    ...(recovered ? { recovered: true } : {}),
  };
}

function applyStatus(r: WriteReport): RunStatus {
  if (r.applied === 0) return "FAILED";
  return r.applied === r.attempted && r.verified === r.applied ? "APPLIED" : "PARTIAL";
}

function rollbackStatus(r: WriteReport): RunStatus {
  return r.applied === r.attempted && r.verified === r.applied ? "ROLLED_BACK" : "ROLLBACK_PARTIAL";
}

/** The order report items are listed in: the order the run listed them. */
function applyOrder(rowsJson: string): string[] {
  return (JSON.parse(rowsJson) as ReviewRow[]).filter(isWritable).map((r) => r.skuId);
}

function appliedItems(applyJson: string | null): WriteItem[] {
  return (applyJson ? (JSON.parse(applyJson) as WriteReport).items : []).filter(
    (i) => i.status === "applied",
  );
}

function unsent(p: WritePlanItem): WriteItem {
  return {
    skuId: p.skuId,
    title: p.title,
    fromPrice: p.fromPrice,
    toPrice: p.toPrice,
    status: "applied",
    error: null,
    livePriceAfter: null,
    verified: false,
  };
}

async function claim(
  shop: string,
  runId: string,
  from: string,
  to: WritingStatus,
): Promise<boolean> {
  const now = new Date();
  const claimed = await prisma.run.updateMany({
    where: { id: runId, shop, status: from },
    data: { status: to, writeStartedAt: now, writeHeartbeatAt: now, writePlanJson: null },
  });
  return claimed.count === 1;
}

/** Undo a claim when the write failed before any mutation could be sent. */
async function release(runId: string, writing: WritingStatus, back: string): Promise<void> {
  await prisma.run.updateMany({
    where: { id: runId, status: writing },
    data: {
      status: back,
      // A preview carries no apply report (the code before the write journal
      // saved partial progress here; a run going back to PREVIEW drops it).
      ...(back === "PREVIEW" ? { applyJson: null } : {}),
      writeStartedAt: null,
      writeHeartbeatAt: null,
      writePlanJson: null,
    },
  });
}

// Both only touch a run that is still mid-write, so a write that outlives a
// recovery cannot put journal columns back on a finished run.
async function savePlan(runId: string, writing: WritingStatus, plan: WritePlan): Promise<void> {
  await prisma.run.updateMany({
    where: { id: runId, status: writing },
    data: { writePlanJson: JSON.stringify(plan), writeHeartbeatAt: new Date() },
  });
}

async function heartbeat(runId: string, writing: WritingStatus): Promise<void> {
  await prisma.run.updateMany({
    where: { id: runId, status: writing },
    data: { writeHeartbeatAt: new Date() },
  });
}

/**
 * Sends the plan's mutations and verifies them by reading Shopify back, not
 * by trusting the mutation response. Returns one item per planned variant.
 */
async function executePlan(
  graphql: AdminGraphql,
  runId: string,
  writing: WritingStatus,
  plan: WritePlan,
): Promise<WriteItem[]> {
  const items = plan.items.map(unsent);
  const itemFor = new Map(plan.items.map((p, i) => [p.variantId, items[i]]));
  const writes: PriceWrite[] = plan.items.map((p) => ({
    variantId: p.variantId,
    productId: p.productId,
    priceCents: p.toPrice,
  }));

  const outcomes = await writePrices(graphql, writes, async (chunk) => {
    for (const [variantId, outcome] of chunk) {
      const item = itemFor.get(variantId) as WriteItem;
      if (!outcome.ok) {
        item.status = "api_error";
        item.error = outcome.error;
      }
    }
    await heartbeat(runId, writing);
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
  return items;
}

/**
 * Step 4, in one transaction: the final status and report, and a log row for
 * every price this write changed. The update is conditional on the run still
 * being in `writing`, so a write and a recovery can never both finish it, and
 * a variant already logged for this run and kind is never logged again.
 *
 * `at` is when the change was confirmed. For a recovered write that is later
 * than the change itself, which only makes the velocity rules more cautious.
 */
async function finishWrite(
  shop: string,
  runId: string,
  writing: WritingStatus,
  kind: WritePlan["kind"],
  status: RunStatus,
  report: WriteReport,
  changed: WriteItem[],
): Promise<RunView> {
  const at = new Date();
  const saved = await prisma.$transaction(async (tx) => {
    const done = await tx.run.updateMany({
      where: { id: runId, shop, status: writing },
      data: {
        status,
        ...(kind === "apply"
          ? { applyJson: JSON.stringify(report) }
          : { rollbackJson: JSON.stringify(report), rolledBackAt: at }),
        writeStartedAt: null,
        writeHeartbeatAt: null,
        writePlanJson: null,
      },
    });
    if (done.count !== 1) {
      throw new Error("This write was already finished, or reconciled after an interruption.");
    }
    const logged = new Set(
      (
        await tx.priceChange.findMany({
          where: { shop, runId, kind },
          select: { variantId: true },
        })
      ).map((c) => c.variantId),
    );
    const fresh = changed.filter((i) => !logged.has(i.skuId));
    if (fresh.length > 0) {
      await tx.priceChange.createMany({
        data: fresh.map((i) => ({
          shop,
          variantId: i.skuId,
          at,
          fromCents: i.fromPrice,
          toCents: i.toPrice,
          runId,
          kind,
        })),
      });
    }
    return tx.run.findUniqueOrThrow({ where: { id: runId } });
  });
  return toView(saved);
}

/** Items the write changed on Shopify: applied, and not read back unchanged. */
function changedBy(items: WriteItem[]): WriteItem[] {
  return items.filter((i) => i.status === "applied" && i.livePriceAfter !== i.fromPrice);
}

function interruptedMessage(error: unknown): Error {
  const why = error instanceof Error ? error.message : String(error);
  return new Error(
    `The write stopped after it started sending prices to Shopify (${why}). ` +
      "Prices may be partly changed; use \"Check what was written\" to reconcile.",
  );
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
    throw new Error(`Only a preview can be applied; this run is ${describeStatus(record.status)}.`);
  }
  const rows = (JSON.parse(record.rowsJson) as ReviewRow[]).filter(isWritable);
  if (rows.length === 0) {
    throw new Error("This run has no price changes to apply.");
  }
  await assertNoUnfinishedWrite(shop);

  // A second click or a crash can never apply the same preview twice.
  if (!(await claim(shop, runId, "PREVIEW", "APPLYING"))) {
    throw new Error("This run is already being applied or has been applied.");
  }

  let sent = false;
  try {
    const live = await fetchLivePrices(graphql, rows.map((r) => r.variantId));

    const settled: WriteItem[] = [];
    const items: WritePlanItem[] = [];
    for (const row of rows) {
      const d = row.decision;
      const price = live.get(row.variantId);
      const planned: WritePlanItem = {
        skuId: row.skuId,
        variantId: row.variantId,
        productId: row.productId,
        title: row.title,
        fromPrice: d.current_price,
        toPrice: d.final_price,
      };
      if (price === undefined) {
        settled.push({ ...unsent(planned), status: "api_error", error: "The variant no longer exists in Shopify." });
      } else if (price !== d.current_price) {
        settled.push({
          ...unsent(planned),
          status: "stale_price",
          error: `Live price is ${price} cents; the decision was made against ${d.current_price}.`,
          livePriceAfter: price,
        });
      } else {
        items.push(planned);
      }
    }

    const plan: WritePlan = { kind: "apply", attempted: rows.length, items, settled };
    await savePlan(runId, "APPLYING", plan);
    sent = items.length > 0;
    const written = await executePlan(graphql, runId, "APPLYING", plan);

    const report = buildReport([...settled, ...written], rows.length, rows.map((r) => r.skuId));
    return await finishWrite(shop, runId, "APPLYING", "apply", applyStatus(report), report, changedBy(written));
  } catch (error) {
    // Nothing reached Shopify: the preview is still a valid preview.
    if (!sent) {
      await release(runId, "APPLYING", "PREVIEW");
      throw error;
    }
    // Something may have: leave the journal for recoverRun.
    throw interruptedMessage(error);
  }
}

const ROLLBACKABLE = ["APPLIED", "PARTIAL", "ROLLBACK_PARTIAL"];

/**
 * What a rollback has to do: every variant the apply changed, minus those an
 * earlier rollback attempt already restored and verified. `wroteEarlier` is
 * what an earlier attempt wrote without being able to verify.
 */
function rollbackCandidates(record: RunRecord): {
  applied: WriteItem[];
  restored: Map<string, WriteItem>;
  wroteEarlier: Set<string>;
  remaining: WriteItem[];
} {
  const applied = appliedItems(record.applyJson);
  const earlier = record.rollbackJson ? (JSON.parse(record.rollbackJson) as WriteReport).items : [];
  const restored = new Map(
    earlier.filter((i) => i.status === "applied" && i.verified).map((i) => [i.skuId, i]),
  );
  const wroteEarlier = new Set(earlier.filter((i) => i.status === "applied").map((i) => i.skuId));
  const remaining = applied.filter((i) => !restored.has(i.skuId));
  return { applied, restored, wroteEarlier, remaining };
}

/**
 * Restores every variant the run changed to its prior price, skipping any
 * whose live price is no longer the price the run applied, then re-reads.
 * After ROLLBACK_PARTIAL it can be run again: variants already restored are
 * kept as they are and only the rest are attempted.
 */
export async function rollbackRun(
  graphql: AdminGraphql,
  shop: string,
  runId: string,
): Promise<RunView> {
  const record = await loadRecord(shop, runId);
  if (!record) throw new Error("Run not found");
  if (!ROLLBACKABLE.includes(record.status)) {
    throw new Error(
      `Only an applied or partly rolled back run can be rolled back; this run is ${describeStatus(record.status)}.`,
    );
  }
  const { applied, restored, wroteEarlier, remaining } = rollbackCandidates(record);
  if (applied.length === 0) throw new Error("This run applied no price changes to roll back.");
  if (remaining.length === 0) throw new Error("Every price this run changed is already restored.");

  await assertNoUnfinishedWrite(shop);
  const previous = record.status;
  if (!(await claim(shop, runId, previous, "ROLLING_BACK"))) {
    throw new Error("This run is already being rolled back.");
  }

  const productOf = new Map(
    (JSON.parse(record.rowsJson) as ReviewRow[]).map((r) => [r.skuId, r.productId]),
  );
  let sent = false;
  try {
    const live = await fetchLivePrices(graphql, remaining.map((i) => i.skuId));

    // From the rollback's point of view: it moves the price from what the run
    // applied back to what the run replaced.
    const settled: WriteItem[] = [...restored.values()];
    const items: WritePlanItem[] = [];
    for (const original of remaining) {
      const price = live.get(original.skuId);
      const productId = productOf.get(original.skuId);
      const planned: WritePlanItem = {
        skuId: original.skuId,
        variantId: original.skuId,
        productId: productId ?? "",
        title: original.title,
        fromPrice: original.toPrice,
        toPrice: original.fromPrice,
      };
      if (price === undefined || !productId) {
        settled.push({ ...unsent(planned), status: "api_error", error: "The variant no longer exists in Shopify." });
      } else if (price === original.toPrice) {
        items.push(planned);
      } else if (price === original.fromPrice && wroteEarlier.has(original.skuId)) {
        // An earlier attempt wrote this and could not verify it; it did land.
        settled.push({ ...unsent(planned), livePriceAfter: price, verified: true });
      } else {
        settled.push({
          ...unsent(planned),
          status: "edited_since_apply",
          error: `Live price is ${price} cents, not the ${original.toPrice} this run applied; left alone.`,
          livePriceAfter: price,
        });
      }
    }

    const plan: WritePlan = { kind: "rollback", attempted: applied.length, items, settled };
    await savePlan(runId, "ROLLING_BACK", plan);
    sent = items.length > 0;
    const written = await executePlan(graphql, runId, "ROLLING_BACK", plan);

    // Rollbacks are price changes too, so they count toward velocity.
    const report = buildReport([...settled, ...written], applied.length, applied.map((i) => i.skuId));
    return await finishWrite(shop, runId, "ROLLING_BACK", "rollback", rollbackStatus(report), report, changedBy(written));
  } catch (error) {
    if (!sent) {
      await release(runId, "ROLLING_BACK", previous);
      throw error;
    }
    throw interruptedMessage(error);
  }
}

/** What the live price says about one planned variant. */
function reconcile(p: WritePlanItem, live: number | undefined): WriteItem {
  const item = unsent(p);
  if (live === undefined) {
    return { ...item, status: "api_error", error: "The variant no longer exists in Shopify." };
  }
  item.livePriceAfter = live;
  if (live === p.toPrice) return { ...item, verified: true }; // the write landed
  if (live === p.fromPrice) {
    return { ...item, status: "not_written", error: "The write was interrupted before this price changed." };
  }
  return {
    ...item,
    status: "edited_since_apply",
    error:
      `Live price is ${live} cents: neither the ${p.fromPrice} before this write nor the ` +
      `${p.toPrice} it set. It was changed outside this write; left alone.`,
  };
}

/**
 * The plan a write would have stored, rebuilt from the run: for an apply,
 * every writable row; for a rollback, every variant not yet restored. Used
 * when a write died before storing its plan, which includes runs left
 * mid-write by the code before the write journal existed.
 */
function reconstructPlan(record: RunRecord, writing: WritingStatus): WritePlan {
  if (writing === "APPLYING") {
    const rows = (JSON.parse(record.rowsJson) as ReviewRow[]).filter(isWritable);
    return {
      kind: "apply",
      attempted: rows.length,
      settled: [],
      items: rows.map((r) => ({
        skuId: r.skuId,
        variantId: r.variantId,
        productId: r.productId,
        title: r.title,
        fromPrice: r.decision.current_price,
        toPrice: r.decision.final_price,
      })),
    };
  }
  const productOf = new Map(
    (JSON.parse(record.rowsJson) as ReviewRow[]).map((r) => [r.skuId, r.productId]),
  );
  const { applied, restored, remaining } = rollbackCandidates(record);
  return {
    kind: "rollback",
    attempted: applied.length,
    settled: [...restored.values()],
    items: remaining.map((o) => ({
      skuId: o.skuId,
      variantId: o.skuId,
      productId: productOf.get(o.skuId) ?? "",
      title: o.title,
      fromPrice: o.toPrice,
      toPrice: o.fromPrice,
    })),
  };
}

/** The status a run had before a write claimed it, when the plan never got stored. */
function statusBeforeWrite(record: RunRecord, writing: WritingStatus): RunStatus {
  if (writing === "APPLYING") return "PREVIEW";
  if (record.rollbackJson) return "ROLLBACK_PARTIAL";
  const apply = record.applyJson ? (JSON.parse(record.applyJson) as WriteReport) : null;
  return apply ? applyStatus(apply) : "APPLIED";
}

/**
 * Reconciles a write that was interrupted (status APPLYING or ROLLING_BACK
 * with a stale heartbeat). Reads the live price of every planned variant and
 * reports the facts: at the planned price -> applied (verified); still at the
 * price before -> not_written; anything else -> edited_since_apply. Stores the
 * report, logs each change it confirms exactly once, and sets the final
 * status, after which the run can be rolled back (or the rollback retried)
 * as usual.
 *
 * If the write died before storing its plan, the plan is rebuilt from the run
 * and checked the same way. When Shopify shows that none of it landed, the
 * run goes back to where it was: an apply to PREVIEW, a rollback to the status
 * it had before.
 *
 * Idempotent: on a run with no unfinished write it changes nothing and
 * returns the run as it is.
 */
export async function recoverRun(
  graphql: AdminGraphql,
  shop: string,
  runId: string,
): Promise<RunView> {
  const record = await loadRecord(shop, runId);
  if (!record) throw new Error("Run not found");
  if (!isWriting(record.status)) return toView(record);
  if (!isInterrupted(record)) {
    throw new Error("A write on this run is still in progress. Check again in a couple of minutes.");
  }
  const writing = record.status;

  const stored = record.writePlanJson ? (JSON.parse(record.writePlanJson) as WritePlan) : null;
  const plan = stored ?? reconstructPlan(record, writing);

  const live = await fetchLivePrices(graphql, plan.items.map((p) => p.variantId));
  const reconciled = plan.items.map((p) => reconcile(p, live.get(p.variantId)));
  if (!stored && !reconciled.some((i) => i.status === "applied")) {
    await release(runId, writing, statusBeforeWrite(record, writing));
    return toView((await loadRecord(shop, runId)) as RunRecord);
  }
  const order =
    plan.kind === "apply"
      ? applyOrder(record.rowsJson)
      : appliedItems(record.applyJson).map((i) => i.skuId);
  const report = buildReport([...plan.settled, ...reconciled], plan.attempted, order, true);
  const status = plan.kind === "apply" ? applyStatus(report) : rollbackStatus(report);
  return finishWrite(shop, runId, writing, plan.kind, status, report, changedBy(reconciled));
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
      rowsJson: true,
      applyJson: true,
      rolledBackAt: true,
      writeStartedAt: true,
      writeHeartbeatAt: true,
    },
  });
  return records.map((r) => {
    const policy = JSON.parse(r.policyJson) as Policy;
    const rows = JSON.parse(r.rowsJson) as ReviewRow[];
    const counts = outcomeCounts(rows.map((row) => row.decision));
    const apply = r.applyJson ? (JSON.parse(r.applyJson) as WriteReport) : null;
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      status: r.status as RunStatus,
      interrupted: isInterrupted(r),
      policyId: policy.id,
      policyVersion: policy.version,
      policyHash: r.policyHash,
      proposals: rows.length - counts.no_proposal,
      accepted: counts.accepted,
      adjusted: counts.adjusted,
      heldBack: counts.held_back,
      applied: apply?.applied ?? 0,
      rolledBackAt: r.rolledBackAt ? r.rolledBackAt.toISOString() : null,
    };
  });
}
