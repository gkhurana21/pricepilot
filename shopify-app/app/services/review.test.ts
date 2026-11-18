import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => {
  const { makeTestDb } = await import("./testing/db");
  return { default: await makeTestDb() };
});

import prisma from "../db.server";
import { formatCents } from "./money";
import { applyRun, createRun, getLatestRun, getPolicy, getRun, listRuns, rollbackRun } from "./review.server";
import { buildStore, SHOP, V } from "./testing/store";
import type { FakeAdmin } from "./testing/fake-admin";
import type { RunView } from "./types";

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
    expect(list[0]).toMatchObject({ id: run.id, status: "PREVIEW", proposals: 3, adjusted: 2, heldBack: 1, applied: 0, rolledBackAt: null });
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
