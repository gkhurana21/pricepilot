import { describe, expect, it } from "vitest";
import {
  fetchLivePrices,
  fetchOrders,
  fetchVariants,
  VARIANTS_PER_MUTATION,
  writePrices,
} from "./catalog.server";
import { dayIndex } from "./observations";
import { daysAgoIso, FakeAdmin } from "./testing/fake-admin";
import type { FakeVariant } from "./testing/fake-admin";

function fv(n: number, over: Partial<FakeVariant> = {}): FakeVariant {
  return {
    id: `gid://shopify/ProductVariant/${n}`,
    title: "Default Title",
    sku: `S${n}`,
    price: "10.00",
    inventoryQuantity: 5,
    cost: "4.0",
    product: { id: "gid://shopify/Product/1", title: "P", handle: "p", productType: "t", tags: [], status: "ACTIVE" },
    ...over,
  };
}

describe("fetchVariants", () => {
  it("pages through the whole catalog and parses money", async () => {
    const admin = new FakeAdmin();
    for (let i = 1; i <= 230; i++) admin.addVariant(fv(i));
    admin.addVariant(fv(231, { cost: null, price: "21.5" }));
    admin.addVariant(fv(232, { cost: "4.125" })); // sub-cent cost: unknown, not rounded
    const variants = await fetchVariants(admin.graphql);
    expect(variants).toHaveLength(232);
    expect(variants[0]).toMatchObject({ priceCents: 1000, unitCostCents: 400, sku: "S1" });
    expect(variants[230]).toMatchObject({ priceCents: 2150, unitCostCents: null });
    expect(variants[231].unitCostCents).toBeNull();
  });
});

describe("fetchOrders", () => {
  const since = dayIndex(new Date()) - 100;

  it("pages, skips cancelled orders and lines with no variant, and reads prices", async () => {
    const admin = new FakeAdmin();
    for (let i = 0; i < 8; i++) {
      admin.orders.push({
        processedAt: daysAgoIso(i + 1),
        tags: ["pricepilot-synthetic"],
        lines: [
          { variantId: "v1", quantity: 2, price: "21.5", discounted: "19.35" },
          { variantId: null, quantity: 1, price: "5.00" },
        ],
      });
    }
    admin.orders.push({ processedAt: daysAgoIso(2), tags: [], cancelledAt: "2026-11-01T00:00:00Z", lines: [{ variantId: "v1", quantity: 9, price: "1.00" }] });
    admin.orders.push({ processedAt: daysAgoIso(150), tags: [], lines: [{ variantId: "v1", quantity: 9, price: "1.00" }] }); // outside window

    const read = await fetchOrders(admin.graphql, since);
    expect(read.orderCount).toBe(8);
    expect(read.lines).toHaveLength(8);
    expect(read.lines[0]).toMatchObject({ variantId: "v1", quantity: 2, unitPriceCents: 2150, discountedUnitPriceCents: 1935 });
    expect(read.allSynthetic).toBe(true);
  });

  it("allSynthetic needs at least one order and every order tagged", async () => {
    const admin = new FakeAdmin();
    expect(await fetchOrders(admin.graphql, since)).toMatchObject({ orderCount: 0, allSynthetic: false });
    admin.orders.push({ processedAt: daysAgoIso(1), tags: ["pricepilot-synthetic"], lines: [{ variantId: "v1", quantity: 1, price: "1" }] });
    admin.orders.push({ processedAt: daysAgoIso(1), tags: ["other"], lines: [{ variantId: "v1", quantity: 1, price: "1" }] });
    expect((await fetchOrders(admin.graphql, since)).allSynthetic).toBe(false);
  });

  it("asks for no order id and no customer field (what the app declares it reads)", async () => {
    const admin = new FakeAdmin();
    const queries: string[] = [];
    const recording: typeof admin.graphql = (q, o) => {
      queries.push(q);
      return admin.graphql(q, o);
    };
    await fetchOrders(recording, dayIndex(new Date()) - 10);
    const fields = queries[0].slice(queries[0].indexOf("nodes {"));
    expect(fields).not.toMatch(/\bid\b(?! \})/); // only `variant { id }` names an id
    expect(fields).not.toMatch(/customer|email|phone|address|billing|shipping|name\b/i);
    expect(fields).toMatch(/processedAt[\s\S]*currentQuantity[\s\S]*variant \{ id \}/);
  });

  it("surfaces GraphQL errors", async () => {
    const admin = new FakeAdmin();
    admin.failReads = true;
    await expect(fetchOrders(admin.graphql, since)).rejects.toThrow(/boom/);
  });
});

describe("fetchLivePrices", () => {
  it("omits variants that no longer exist", async () => {
    const admin = new FakeAdmin();
    admin.addVariant(fv(1, { price: "12.34" }));
    const prices = await fetchLivePrices(admin.graphql, [fv(1).id, "gid://shopify/ProductVariant/999"]);
    expect([...prices]).toEqual([[fv(1).id, 1234]]);
  });
});

describe("writePrices", () => {
  it("chunks a product's variants in groups of 250 and sends decimal strings", async () => {
    const admin = new FakeAdmin();
    const writes = [];
    for (let i = 1; i <= 600; i++) {
      admin.addVariant(fv(i));
      writes.push({ variantId: fv(i).id, productId: "gid://shopify/Product/1", priceCents: 1099 });
    }
    const outcomes = await writePrices(admin.graphql, writes);
    expect(admin.mutationCalls).toBe(Math.ceil(600 / VARIANTS_PER_MUTATION));
    expect(outcomes.size).toBe(600);
    expect([...outcomes.values()].every((o) => o.ok)).toBe(true);
    expect(admin.variants.get(fv(1).id)!.price).toBe("10.99");
  });

  it("groups by product and attributes userErrors to the right variant by index", async () => {
    const admin = new FakeAdmin();
    for (let i = 1; i <= 3; i++) admin.addVariant(fv(i));
    admin.rejectWith.set(fv(2).id, "Price cannot be negative");
    const chunks: number[] = [];
    const outcomes = await writePrices(
      admin.graphql,
      [
        { variantId: fv(1).id, productId: "gid://shopify/Product/1", priceCents: 500 },
        { variantId: fv(2).id, productId: "gid://shopify/Product/1", priceCents: 600 },
        { variantId: fv(3).id, productId: "gid://shopify/Product/2", priceCents: 700 },
      ],
      (c) => void chunks.push(c.size),
    );
    expect(admin.mutationCalls).toBe(2);
    expect(chunks).toEqual([2, 1]);
    expect(outcomes.get(fv(1).id)).toEqual({ ok: true, error: null });
    expect(outcomes.get(fv(2).id)).toEqual({ ok: false, error: "Price cannot be negative" });
    expect(outcomes.get(fv(3).id)?.ok).toBe(true);
  });

  it("marks a whole chunk failed when the request itself fails, and carries on", async () => {
    const admin = new FakeAdmin();
    admin.addVariant(fv(1));
    const real = admin.graphql;
    admin.graphql = async () => {
      throw new Error("network down");
    };
    const outcomes = await writePrices(admin.graphql, [
      { variantId: fv(1).id, productId: "gid://shopify/Product/1", priceCents: 500 },
    ]);
    expect(outcomes.get(fv(1).id)).toEqual({ ok: false, error: "network down" });
    admin.graphql = real;
  });
});
