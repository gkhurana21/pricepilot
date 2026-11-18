import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => {
  const { makeTestDb } = await import("./testing/db");
  return { default: await makeTestDb() };
});

import prisma from "../db.server";
import { formatCents } from "./money";
import {
  applyRun,
  createRun,
  findUnfinishedWrite,
  getLatestRun,
  getPolicy,
  getRun,
  listRuns,
  recoverRun,
  rollbackRun,
  WRITE_TIMEOUT_MS,
} from "./review.server";
import { buildStore, SHOP, V } from "./testing/store";
import type { FakeAdmin } from "./testing/fake-admin";
import type { RunView, WritePlan } from "./types";

let admin: FakeAdmin;

beforeEach(async () => {
  await prisma.priceChange.deleteMany();
  await prisma.run.deleteMany();
  await prisma.policyRecord.deleteMany();
  admin = buildStore();
});

const row = (run: RunView, id: string) => run.rows.find((r) => r.variantId === id);


const ADJUSTABLE = [V.ethiopia, V.colombia];

describe("getPolicy", () => {
  it("creates the default policy once, with the hash from the engine", async () => {
    const first = await getPolicy(SHOP);
    expect(first.policyHash).toMatch(/^sha256:[0-9a-f]{16}$/);
    const again = await getPolicy(SHOP);
    expect(again).toEqual(first);
    expect(await prisma.policyRecord.count({ where: { shop: SHOP } })).toBe(1);
  });
});

describe("createRun", () => {
  it("produces rows with the right outcomes and stores a PREVIEW", async () => {
    const run = await createRun(admin.graphql, SHOP);

    expect(run.status).toBe("PREVIEW");
    expect(run.shop).toBe(SHOP);
    expect(run.policyHash).toMatch(/^sha256:/);
    expect(admin.mutationCalls).toBe(0); // nothing written to Shopify

    // Draft and probe products are not reviewed at all.
    expect(run.rows.map((r) => r.variantId).sort()).toEqual(
      [V.ethiopia, V.colombia, V.subscription, V.flat, V.noCost].sort(),
    );

    // Adjusted: the engine proposed a cut deeper than the policy allows.
    for (const id of ADJUSTABLE) {
      const r = row(run, id)!;
      expect(r.outcome).toBe("adjusted");
      expect(r.decidingRule).toBe("max_decrease");
      expect(r.decision!.final_price).toBeGreaterThan(0);
      expect(r.decision!.final_price).toBeLessThan(r.currentPrice);
      expect(r.proposal).not.toBeNull();
      expect(r.estimate.method).not.toBe("refused");
      expect(r.unitCost).toBe(800);
      expect(r.group).toBe("retail-beans");
      expect(r.title).toBe(id === V.ethiopia ? "ethiopia" : "colombia");
    }

    // Held back: excluded by tag.
    const box = row(run, V.subscription)!;
    expect(box.outcome).toBe("held_back");
    expect(box.decidingRule).toBe("excluded");
    expect(box.decision!.final_price).toBe(0);

    // No proposal: the estimator declined, the enforcer never saw them.
    const flat = row(run, V.flat)!;
    expect(flat.outcome).toBe("no_proposal");
    expect(flat.decision).toBeNull();
    expect(flat.noProposalCode).toBe("too_few_distinct_prices");
    const noCost = row(run, V.noCost)!;
    expect(noCost.outcome).toBe("no_proposal");
    expect(noCost.unitCost).toBeNull();
    expect(noCost.noProposalReason).toMatch(/cost/i);

    // The enforcer's own summary of the proposals it saw.
    expect(run.summary).toMatchObject({ total: 3, clamped: 2, rejected: 1, approved: 0 });

    expect(run.dataBasis).toMatchObject({ synthetic: true, days: 100 });
    expect(run.dataBasis.orderCount).toBe(700);

    // Round trip through storage.
    expect(await getRun(SHOP, run.id)).toEqual(run);
    expect((await getLatestRun(SHOP))?.id).toBe(run.id);
    expect(await getRun("other-shop.myshopify.com", run.id)).toBeNull();
    const list = await listRuns(SHOP);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: run.id,
      status: "PREVIEW",
      interrupted: false,
      proposals: 3,
      accepted: 0,
      adjusted: 2,
      heldBack: 1,
      applied: 0,
      rolledBackAt: null,
    });
    expect(run.interrupted).toBe(false);
    expect(run.writeStartedAt).toBeNull();
  });

  it("is not synthetic when any order lacks the synthetic tag, and has no true elasticity", async () => {
    admin.orders[0].tags = [];
    const run = await createRun(admin.graphql, SHOP);
    expect(run.dataBasis.synthetic).toBe(false);
    expect(run.rows.every((r) => r.trueElasticity === null)).toBe(true);
  });

  it("stores no order rows or customer data", async () => {
    const run = await createRun(admin.graphql, SHOP);
    const stored = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    const blob = stored.rowsJson + stored.dataBasisJson + stored.summaryJson;
    expect(blob).not.toMatch(/processedAt|customer|email|gid:\/\/shopify\/Order/i);
  });
});

describe("applyRun", () => {
  it("writes only the engine's final prices, then verifies by re-reading", async () => {
    const run = await createRun(admin.graphql, SHOP);
    const applied = await applyRun(admin.graphql, SHOP, run.id);

    expect(applied.status).toBe("APPLIED");
    expect(applied.apply).toMatchObject({ attempted: 2, applied: 2, skipped: 0, failed: 0, verified: 2 });

    // Exactly the two adjustable variants were written, at the engine's price.
    expect(admin.writes.map((w) => w.variantId).sort()).toEqual([...ADJUSTABLE].sort());
    for (const id of ADJUSTABLE) {
      const final = row(run, id)!.decision!.final_price;
      expect(admin.writes.find((w) => w.variantId === id)!.price).toBe(formatCents(final));
      expect(admin.priceCents(id)).toBe(final);
      const item = applied.apply!.items.find((i) => i.skuId === id)!;
      expect(item).toMatchObject({ status: "applied", fromPrice: 2000, toPrice: final, livePriceAfter: final, verified: true });
    }
    // Held-back and no-proposal variants were never touched.
    expect(admin.priceCents(V.subscription)).toBe(2000);
    expect(admin.priceCents(V.flat)).toBe(2000);

    const log = await prisma.priceChange.findMany({ where: { shop: SHOP } });
    expect(log).toHaveLength(2);
    expect(log.every((c) => c.kind === "apply" && c.runId === run.id && c.fromCents === 2000)).toBe(true);
  });

  it("only applies a PREVIEW, and only once", async () => {
    const run = await createRun(admin.graphql, SHOP);
    await applyRun(admin.graphql, SHOP, run.id);
    const calls = admin.mutationCalls;
    await expect(applyRun(admin.graphql, SHOP, run.id)).rejects.toThrow(/preview/i);
    expect(admin.mutationCalls).toBe(calls);
    await expect(applyRun(admin.graphql, SHOP, "nope")).rejects.toThrow(/not found/i);
    await expect(applyRun(admin.graphql, "other.myshopify.com", run.id)).rejects.toThrow(/not found/i);
  });

  it("persists in-progress before the first write", async () => {
    const run = await createRun(admin.graphql, SHOP);
    let statusAtFirstWrite: string | undefined;
    const original = admin.graphql;
    admin.graphql = async (q, o) => {
      if (q.includes("productVariantsBulkUpdate") && statusAtFirstWrite === undefined) {
        statusAtFirstWrite = (await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status;
      }
      return original(q, o);
    };
    await applyRun(admin.graphql, SHOP, run.id);
    expect(statusAtFirstWrite).toBe("APPLYING");
  });

  it("skips a variant whose price changed after the preview (stale_price)", async () => {
    const run = await createRun(admin.graphql, SHOP);
    admin.setPrice(V.colombia, "21.00"); // a merchant edit after the preview
    const applied = await applyRun(admin.graphql, SHOP, run.id);

    expect(applied.status).toBe("PARTIAL");
    expect(applied.apply).toMatchObject({ attempted: 2, applied: 1, skipped: 1, failed: 0 });
    const stale = applied.apply!.items.find((i) => i.skuId === V.colombia)!;
    expect(stale.status).toBe("stale_price");
    expect(stale.livePriceAfter).toBe(2100);
    expect(admin.priceCents(V.colombia)).toBe(2100); // untouched
    expect(admin.writes.map((w) => w.variantId)).toEqual([V.ethiopia]);
    expect(await prisma.priceChange.count({ where: { shop: SHOP } })).toBe(1);
  });

  it("handles a userErrors partial failure per variant", async () => {
    const run = await createRun(admin.graphql, SHOP);
    admin.rejectWith.set(V.ethiopia, "Price is invalid");
    const applied = await applyRun(admin.graphql, SHOP, run.id);

    expect(applied.status).toBe("PARTIAL");
    expect(applied.apply).toMatchObject({ applied: 1, failed: 1 });
    const failed = applied.apply!.items.find((i) => i.skuId === V.ethiopia)!;
    expect(failed).toMatchObject({ status: "api_error", error: "Price is invalid", verified: false });
    expect(failed.livePriceAfter).toBe(2000);
    expect(admin.priceCents(V.ethiopia)).toBe(2000);
    expect(admin.priceCents(V.colombia)).toBe(row(run, V.colombia)!.decision!.final_price);
    const log = await prisma.priceChange.findMany({ where: { shop: SHOP } });
    expect(log.map((c) => c.variantId)).toEqual([V.colombia]);
  });

  it("does not trust a success response: a write that did not take is unverified and not logged", async () => {
    const run = await createRun(admin.graphql, SHOP);
    admin.silentlyDrop.add(V.ethiopia);
    const applied = await applyRun(admin.graphql, SHOP, run.id);

    expect(applied.status).toBe("PARTIAL");
    const item = applied.apply!.items.find((i) => i.skuId === V.ethiopia)!;
    expect(item.verified).toBe(false);
    expect(item.livePriceAfter).toBe(2000);
    expect(applied.apply!.verified).toBe(1);
    const log = await prisma.priceChange.findMany({ where: { shop: SHOP } });
    expect(log.map((c) => c.variantId)).toEqual([V.colombia]);
  });

  it("is FAILED when nothing could be written", async () => {
    const run = await createRun(admin.graphql, SHOP);
    for (const id of ADJUSTABLE) admin.rejectWith.set(id, "nope");
    const applied = await applyRun(admin.graphql, SHOP, run.id);
    expect(applied.status).toBe("FAILED");
    expect(await prisma.priceChange.count()).toBe(0);
  });

  it("leaves the preview intact if Shopify cannot be read before any write", async () => {
    const run = await createRun(admin.graphql, SHOP);
    admin.failReads = true;
    await expect(applyRun(admin.graphql, SHOP, run.id)).rejects.toThrow(/boom/);
    admin.failReads = false;
    expect((await getRun(SHOP, run.id))!.status).toBe("PREVIEW");
    expect((await applyRun(admin.graphql, SHOP, run.id)).status).toBe("APPLIED");
  });

  it("a second run right after apply is held back by the velocity rule", async () => {
    const first = await createRun(admin.graphql, SHOP);
    await applyRun(admin.graphql, SHOP, first.id);

    const second = await createRun(admin.graphql, SHOP);
    for (const id of ADJUSTABLE) {
      const r = row(second, id)!;
      expect(r.decision).not.toBeNull();
      expect(r.outcome).toBe("held_back");
      expect(r.decidingRule).toBe("velocity_min_days");
    }
    expect(second.summary.rejected_by_rule.velocity_min_days).toBe(2);
    expect(second.summary.rejected_by_rule.excluded).toBe(1);
  });
});

describe("rollbackRun", () => {
  it("restores the exact prior prices and marks the run ROLLED_BACK", async () => {
    const run = await createRun(admin.graphql, SHOP);
    await applyRun(admin.graphql, SHOP, run.id);
    const rolled = await rollbackRun(admin.graphql, SHOP, run.id);

    expect(rolled.status).toBe("ROLLED_BACK");
    expect(rolled.rollback).toMatchObject({ attempted: 2, applied: 2, skipped: 0, failed: 0, verified: 2 });
    for (const id of ADJUSTABLE) expect(admin.priceCents(id)).toBe(2000);
    for (const item of rolled.rollback!.items) {
      expect(item).toMatchObject({ status: "applied", toPrice: 2000, livePriceAfter: 2000, verified: true });
    }
    const stored = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.rolledBackAt).not.toBeNull();

    // Rollbacks are price changes too.
    const log = await prisma.priceChange.findMany({ where: { shop: SHOP, kind: "rollback" } });
    expect(log).toHaveLength(2);
    expect(log.every((c) => c.toCents === 2000)).toBe(true);
    expect(await prisma.priceChange.count({ where: { shop: SHOP } })).toBe(4);

    expect((await listRuns(SHOP))[0]).toMatchObject({ status: "ROLLED_BACK", applied: 2 });
  });

  it("skips a variant edited since the apply and reports ROLLBACK_PARTIAL", async () => {
    const run = await createRun(admin.graphql, SHOP);
    await applyRun(admin.graphql, SHOP, run.id);
    admin.setPrice(V.colombia, "17.50"); // edited by the merchant afterwards
    const rolled = await rollbackRun(admin.graphql, SHOP, run.id);

    expect(rolled.status).toBe("ROLLBACK_PARTIAL");
    expect(rolled.rollback).toMatchObject({ applied: 1, skipped: 1, failed: 0 });
    const skipped = rolled.rollback!.items.find((i) => i.skuId === V.colombia)!;
    expect(skipped.status).toBe("edited_since_apply");
    expect(skipped.livePriceAfter).toBe(1750);
    expect(admin.priceCents(V.colombia)).toBe(1750); // left alone
    expect(admin.priceCents(V.ethiopia)).toBe(2000);
  });

  it("only rolls back an applied run, once", async () => {
    const run = await createRun(admin.graphql, SHOP);
    await expect(rollbackRun(admin.graphql, SHOP, run.id)).rejects.toThrow(/applied/i);
    await applyRun(admin.graphql, SHOP, run.id);
    await rollbackRun(admin.graphql, SHOP, run.id);
    await expect(rollbackRun(admin.graphql, SHOP, run.id)).rejects.toThrow(/rolled back|applied/i);
  });

  it("can roll back what a PARTIAL apply did write", async () => {
    const run = await createRun(admin.graphql, SHOP);
    admin.rejectWith.set(V.ethiopia, "no");
    const applied = await applyRun(admin.graphql, SHOP, run.id);
    expect(applied.status).toBe("PARTIAL");
    admin.rejectWith.clear();
    const rolled = await rollbackRun(admin.graphql, SHOP, run.id);
    expect(rolled.status).toBe("ROLLED_BACK");
    expect(rolled.rollback!.items.map((i) => i.skuId)).toEqual([V.colombia]);
    expect(admin.priceCents(V.colombia)).toBe(2000);
  });
});

// ---- interrupted writes ------------------------------------------------------
//
// A crash is simulated by making the fake Shopify never answer one request:
// the write stops exactly there, as if the process died, and the database is
// left as that process left it. Time passing is simulated by ageing the
// stored heartbeat past WRITE_TIMEOUT_MS.

/** Freezes the nth request whose query contains `name`. Returns whether it was reached. */
function crashAt(name: string, nth: number): { reached: boolean } {
  const state = { reached: false };
  const original = admin.graphql;
  let seen = 0;
  admin.graphql = async (q, o) => {
    if (q.includes(name) && ++seen === nth) {
      state.reached = true;
      return new Promise<Response>(() => {}); // never answers
    }
    return original(q, o);
  };
  return state;
}
// Request names as the services send them (catalog.server.ts).
const PRICE_READ = "PricePilotVariantPrices";
const MUTATION = "productVariantsBulkUpdate";

/** Starts a write that will die at the crash point, and waits until it has. */
async function startAndCrash(
  write: typeof applyRun,
  runId: string,
  state: { reached: boolean },
): Promise<void> {
  void write(admin.graphql, SHOP, runId).catch(() => {});
  await vi.waitFor(() => expect(state.reached).toBe(true));
}

async function age(runId: string): Promise<void> {
  const past = new Date(Date.now() - WRITE_TIMEOUT_MS - 60_000);
  await prisma.run.update({
    where: { id: runId },
    data: { writeStartedAt: past, writeHeartbeatAt: past },
  });
}

const log = (kind?: string) =>
  prisma.priceChange.findMany({ where: { shop: SHOP, ...(kind ? { kind } : {}) } });

const finalPrice = (run: RunView, id: string) => row(run, id)!.decision!.final_price;

describe("recoverRun", () => {
  it("after a crash between the mutations and the final save: reports what landed, logs once, and rolls back", async () => {
    const run = await createRun(admin.graphql, SHOP);
    // The second price read is the verification read after the writes.
    await startAndCrash(applyRun, run.id, crashAt(PRICE_READ, 2));

    // The plan was stored before the first mutation, and both writes landed.
    const stored = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe("APPLYING");
    const plan = JSON.parse(stored.writePlanJson!) as WritePlan;
    expect(plan.kind).toBe("apply");
    expect(plan.items.map((i) => i.variantId).sort()).toEqual([...ADJUSTABLE].sort());
    for (const i of plan.items) {
      expect(i).toMatchObject({ skuId: i.variantId, fromPrice: 2000, toPrice: finalPrice(run, i.variantId) });
      expect(i.productId).toMatch(/^gid:\/\/shopify\/Product\//);
      expect(i.title).not.toBe("");
    }
    for (const id of ADJUSTABLE) expect(admin.priceCents(id)).toBe(finalPrice(run, id));
    expect(await log()).toHaveLength(0);

    // Within the timeout it is a write in flight, and recovery refuses.
    expect((await getRun(SHOP, run.id))!).toMatchObject({ status: "APPLYING", interrupted: false });
    await expect(recoverRun(admin.graphql, SHOP, run.id)).rejects.toThrow(/in progress/);

    await age(run.id);
    const view = (await getRun(SHOP, run.id))!;
    expect(view).toMatchObject({ status: "APPLYING", interrupted: true });
    expect(view.writeStartedAt).not.toBeNull();
    expect((await listRuns(SHOP))[0]).toMatchObject({ status: "APPLYING", interrupted: true });
    expect((await findUnfinishedWrite(SHOP))?.id).toBe(run.id);
    // Nothing new is decided while the log is incomplete.
    await expect(createRun(admin.graphql, SHOP)).rejects.toThrow(/interrupted/);

    const recovered = await recoverRun(admin.graphql, SHOP, run.id);
    expect(recovered.status).toBe("APPLIED");
    expect(recovered.interrupted).toBe(false);
    expect(recovered.writeStartedAt).toBeNull();
    expect(recovered.apply).toMatchObject({ attempted: 2, applied: 2, skipped: 0, failed: 0, verified: 2, recovered: true });
    for (const id of ADJUSTABLE) {
      expect(recovered.apply!.items.find((i) => i.skuId === id)).toMatchObject({
        status: "applied",
        fromPrice: 2000,
        toPrice: finalPrice(run, id),
        livePriceAfter: finalPrice(run, id),
        verified: true,
      });
    }
    const applied = await log("apply");
    expect(applied.map((c) => c.variantId).sort()).toEqual([...ADJUSTABLE].sort());
    expect(applied.every((c) => c.runId === run.id && c.fromCents === 2000)).toBe(true);
    expect(await findUnfinishedWrite(SHOP)).toBeNull();

    // Rollback works as usual and restores the exact prior prices.
    const rolled = await rollbackRun(admin.graphql, SHOP, run.id);
    expect(rolled.status).toBe("ROLLED_BACK");
    for (const id of ADJUSTABLE) expect(admin.priceCents(id)).toBe(2000);
    expect(await log("apply")).toHaveLength(2);
    expect(await log("rollback")).toHaveLength(2);
  });

  it("after a crash part-way through the mutations: one landed, one was never written", async () => {
    const run = await createRun(admin.graphql, SHOP);
    // One mutation per product: the first lands, the second never does.
    await startAndCrash(applyRun, run.id, crashAt(MUTATION, 2));
    await age(run.id);

    const [landed] = ADJUSTABLE.filter((id) => admin.priceCents(id) !== 2000);
    const [untouched] = ADJUSTABLE.filter((id) => admin.priceCents(id) === 2000);
    expect(landed).toBeDefined();
    expect(untouched).toBeDefined();

    const recovered = await recoverRun(admin.graphql, SHOP, run.id);
    expect(recovered.status).toBe("PARTIAL");
    expect(recovered.apply).toMatchObject({ attempted: 2, applied: 1, failed: 1, verified: 1 });
    expect(recovered.apply!.items.find((i) => i.skuId === landed)).toMatchObject({
      status: "applied",
      livePriceAfter: finalPrice(run, landed),
      verified: true,
    });
    expect(recovered.apply!.items.find((i) => i.skuId === untouched)).toMatchObject({
      status: "not_written",
      livePriceAfter: 2000,
      verified: false,
    });
    expect((await log()).map((c) => c.variantId)).toEqual([landed]);

    // Rollback restores exactly what landed, and only that.
    const writes = admin.writes.length;
    const rolled = await rollbackRun(admin.graphql, SHOP, run.id);
    expect(rolled.status).toBe("ROLLED_BACK");
    expect(rolled.rollback!.items.map((i) => i.skuId)).toEqual([landed]);
    expect(admin.writes.slice(writes)).toEqual([{ variantId: landed, price: "20.00" }]);
    for (const id of ADJUSTABLE) expect(admin.priceCents(id)).toBe(2000);
  });

  it("after a crash before any mutation: nothing was written, the run is FAILED, nothing is logged", async () => {
    const run = await createRun(admin.graphql, SHOP);
    await startAndCrash(applyRun, run.id, crashAt(MUTATION, 1));
    await age(run.id);
    expect(admin.mutationCalls).toBe(0);

    const recovered = await recoverRun(admin.graphql, SHOP, run.id);
    expect(recovered.status).toBe("FAILED");
    expect(recovered.apply).toMatchObject({ attempted: 2, applied: 0, failed: 2, verified: 0, recovered: true });
    for (const item of recovered.apply!.items) {
      expect(item).toMatchObject({ status: "not_written", fromPrice: 2000, livePriceAfter: 2000, verified: false });
    }
    expect(await log()).toHaveLength(0);
    for (const id of ADJUSTABLE) expect(admin.priceCents(id)).toBe(2000);

    // Nothing to undo, and a fresh preview can be made.
    await expect(rollbackRun(admin.graphql, SHOP, run.id)).rejects.toThrow(/rolled back/);
    expect((await createRun(admin.graphql, SHOP)).status).toBe("PREVIEW");
  });

  it("after a crash before the plan was stored: the run is a preview again", async () => {
    const run = await createRun(admin.graphql, SHOP);
    // The first price read happens before the plan is chosen.
    await startAndCrash(applyRun, run.id, crashAt(PRICE_READ, 1));
    await age(run.id);
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).writePlanJson).toBeNull();

    const recovered = await recoverRun(admin.graphql, SHOP, run.id);
    expect(recovered).toMatchObject({ status: "PREVIEW", apply: null, interrupted: false, writeStartedAt: null });
    expect(admin.mutationCalls).toBe(0);
    expect((await applyRun(admin.graphql, SHOP, run.id)).status).toBe("APPLIED");
  });

  it("reconciles a run left mid-write before the journal existed (no plan, no timestamps)", async () => {
    const run = await createRun(admin.graphql, SHOP);
    // The old code wrote prices with no plan stored; one of them landed.
    admin.setPrice(V.ethiopia, formatCents(finalPrice(run, V.ethiopia)));
    await prisma.run.update({ where: { id: run.id }, data: { status: "APPLYING" } });
    expect((await getRun(SHOP, run.id))!).toMatchObject({ status: "APPLYING", interrupted: true });

    const recovered = await recoverRun(admin.graphql, SHOP, run.id);
    expect(recovered.status).toBe("PARTIAL");
    expect(recovered.apply!.items.find((i) => i.skuId === V.ethiopia)).toMatchObject({ status: "applied", verified: true });
    expect(recovered.apply!.items.find((i) => i.skuId === V.colombia)).toMatchObject({ status: "not_written" });
    expect((await log()).map((c) => c.variantId)).toEqual([V.ethiopia]);
    expect((await rollbackRun(admin.graphql, SHOP, run.id)).status).toBe("ROLLED_BACK");
    expect(admin.priceCents(V.ethiopia)).toBe(2000);
  });

  it("reports a price that is neither the old nor the new one as edited, and does not log it", async () => {
    const run = await createRun(admin.graphql, SHOP);
    await startAndCrash(applyRun, run.id, crashAt(PRICE_READ, 2));
    admin.setPrice(V.colombia, "17.50"); // someone edits it before anyone checks
    await age(run.id);

    const recovered = await recoverRun(admin.graphql, SHOP, run.id);
    expect(recovered.status).toBe("PARTIAL");
    expect(recovered.apply).toMatchObject({ applied: 1, skipped: 1, failed: 0 });
    const edited = recovered.apply!.items.find((i) => i.skuId === V.colombia)!;
    expect(edited).toMatchObject({ status: "edited_since_apply", livePriceAfter: 1750, verified: false });
    expect(edited.error).toMatch(/neither/);
    expect((await log()).map((c) => c.variantId)).toEqual([V.ethiopia]);
  });

  it("is idempotent: a second call changes nothing and reads nothing", async () => {
    const run = await createRun(admin.graphql, SHOP);
    await startAndCrash(applyRun, run.id, crashAt(MUTATION, 2));
    await age(run.id);

    const first = await recoverRun(admin.graphql, SHOP, run.id);
    const before = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    const logBefore = await log();

    let requests = 0;
    const counting: typeof admin.graphql = async (q, o) => {
      requests++;
      return admin.graphql(q, o);
    };
    const second = await recoverRun(counting, SHOP, run.id);

    expect(second).toEqual(first);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toEqual(before);
    expect(await log()).toEqual(logBefore);

    // On a run that was never interrupted it is a no-op too.
    const preview = await createRun(admin.graphql, SHOP);
    expect(await recoverRun(counting, SHOP, preview.id)).toEqual(preview);
    expect(requests).toBe(0);
  });

  it("recovers when the final save itself fails, without logging twice", async () => {
    const run = await createRun(admin.graphql, SHOP);
    // The final save is the one transaction a write runs; make it fail once.
    const real = prisma.$transaction.bind(prisma);
    const db = prisma as unknown as { $transaction: unknown };
    db.$transaction = () => Promise.reject(new Error("database is locked"));
    try {
      await expect(applyRun(admin.graphql, SHOP, run.id)).rejects.toThrow(/stopped after it started sending/);
    } finally {
      db.$transaction = real;
    }

    // Not put back to PREVIEW: prices were sent, so it waits to be reconciled.
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("APPLYING");
    await age(run.id);
    const recovered = await recoverRun(admin.graphql, SHOP, run.id);
    expect(recovered.status).toBe("APPLIED");
    expect(await log("apply")).toHaveLength(2);
  });

  it("reconciles an interrupted rollback", async () => {
    const run = await createRun(admin.graphql, SHOP);
    await applyRun(admin.graphql, SHOP, run.id);
    await startAndCrash(rollbackRun, run.id, crashAt(PRICE_READ, 2));
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("ROLLING_BACK");
    await age(run.id);
    expect((await getRun(SHOP, run.id))!).toMatchObject({ status: "ROLLING_BACK", interrupted: true });

    const recovered = await recoverRun(admin.graphql, SHOP, run.id);
    expect(recovered.status).toBe("ROLLED_BACK");
    expect(recovered.rollback).toMatchObject({ attempted: 2, applied: 2, verified: 2, recovered: true });
    for (const id of ADJUSTABLE) expect(admin.priceCents(id)).toBe(2000);
    expect(await log("rollback")).toHaveLength(2);
    expect(await log("apply")).toHaveLength(2);
  });

  it("puts a rollback that died before its plan back where it was", async () => {
    const run = await createRun(admin.graphql, SHOP);
    await applyRun(admin.graphql, SHOP, run.id);
    await startAndCrash(rollbackRun, run.id, crashAt(PRICE_READ, 1));
    await age(run.id);
    expect((await recoverRun(admin.graphql, SHOP, run.id)).status).toBe("APPLIED");
    expect((await rollbackRun(admin.graphql, SHOP, run.id)).status).toBe("ROLLED_BACK");
  });
});

describe("rollbackRun retry", () => {
  it("restores the remainder after ROLLBACK_PARTIAL, and never rewrites or re-logs what was restored", async () => {
    const run = await createRun(admin.graphql, SHOP);
    await applyRun(admin.graphql, SHOP, run.id);
    const colombiaFinal = finalPrice(run, V.colombia);
    admin.setPrice(V.colombia, "17.50"); // edited by the merchant
    const first = await rollbackRun(admin.graphql, SHOP, run.id);
    expect(first.status).toBe("ROLLBACK_PARTIAL");
    expect(admin.priceCents(V.ethiopia)).toBe(2000);

    // Still edited: a retry changes nothing and stays partial.
    let writes = admin.writes.length;
    const still = await rollbackRun(admin.graphql, SHOP, run.id);
    expect(still.status).toBe("ROLLBACK_PARTIAL");
    expect(admin.writes.length).toBe(writes);

    // The merchant puts back the price the run applied; the retry restores it.
    admin.setPrice(V.colombia, formatCents(colombiaFinal));
    writes = admin.writes.length;
    const retried = await rollbackRun(admin.graphql, SHOP, run.id);
    expect(retried.status).toBe("ROLLED_BACK");
    expect(admin.writes.slice(writes)).toEqual([{ variantId: V.colombia, price: "20.00" }]);
    for (const id of ADJUSTABLE) expect(admin.priceCents(id)).toBe(2000);
    expect(retried.rollback).toMatchObject({ attempted: 2, applied: 2, skipped: 0, verified: 2 });

    const rollbacks = await log("rollback");
    expect(rollbacks.map((c) => c.variantId).sort()).toEqual([...ADJUSTABLE].sort());
    await expect(rollbackRun(admin.graphql, SHOP, run.id)).rejects.toThrow(/already rolled back/);
  });

  it("retries a variant whose earlier rollback write failed", async () => {
    const run = await createRun(admin.graphql, SHOP);
    await applyRun(admin.graphql, SHOP, run.id);
    admin.rejectWith.set(V.ethiopia, "Temporarily unavailable");
    expect((await rollbackRun(admin.graphql, SHOP, run.id)).status).toBe("ROLLBACK_PARTIAL");
    admin.rejectWith.clear();
    const retried = await rollbackRun(admin.graphql, SHOP, run.id);
    expect(retried.status).toBe("ROLLED_BACK");
    for (const id of ADJUSTABLE) expect(admin.priceCents(id)).toBe(2000);
    expect(await log("rollback")).toHaveLength(2);
  });
});
