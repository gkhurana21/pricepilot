import { describe, expect, it } from "vitest";
import { buildObservations, dayIndex, dayToDate } from "./observations";
import type { OrderLine } from "./observations";

const D0 = dayIndex("2026-10-01T00:00:00Z");
const at = (offset: number, hour = 12) =>
  new Date((D0 + offset) * 86_400_000 + hour * 3_600_000).toISOString();

function line(offset: number, over: Partial<OrderLine> = {}): OrderLine {
  return {
    variantId: "v1",
    processedAt: at(offset),
    quantity: 1,
    unitPriceCents: 2000,
    discountedUnitPriceCents: 2000,
    ...over,
  };
}

describe("dayIndex", () => {
  it("counts UTC days since the epoch", () => {
    expect(dayIndex("1970-01-01T00:00:00Z")).toBe(0);
    expect(dayIndex("1970-01-01T23:59:59Z")).toBe(0);
    expect(dayIndex("1970-01-02T00:00:00Z")).toBe(1);
    // An offset timestamp is read as the UTC instant it names.
    expect(dayIndex("2026-10-01T23:30:00-05:00")).toBe(dayIndex("2026-10-02T00:00:00Z"));
    expect(dayToDate(D0)).toBe("2026-10-01");
  });
  it("rejects garbage", () => {
    expect(() => dayIndex("nope")).toThrow();
  });
});

describe("buildObservations", () => {
  const range = { startDay: D0, endDay: D0 + 9 };

  it("starts at the variant's first sale and fills zero days to the range end", () => {
    const out = buildObservations(
      [line(3, { quantity: 4 }), line(5, { quantity: 2, unitPriceCents: 2200, discountedUnitPriceCents: 2200 })],
      range,
    );
    const obs = out.get("v1");
    expect(obs?.map((o) => o.day)).toEqual([3, 4, 5, 6, 7, 8, 9].map((n) => D0 + n));
    expect(obs?.map((o) => o.units)).toEqual([4, 0, 2, 0, 0, 0, 0]);
    // zero days carry the most recent known price
    expect(obs?.map((o) => o.price)).toEqual([2000, 2000, 2200, 2200, 2200, 2200, 2200]);
    expect(obs?.every((o) => o.on_promo === false)).toBe(true);
  });

  it("flags promo when the dominant price was mostly discounted", () => {
    const out = buildObservations(
      [
        line(0, { quantity: 3, discountedUnitPriceCents: 1600 }),
        line(1, { quantity: 3 }),
        // exactly half discounted is not "more than half"
        line(2, { quantity: 1, discountedUnitPriceCents: 1500 }),
        line(2, { quantity: 1 }),
      ],
      range,
    );
    const obs = out.get("v1") ?? [];
    expect(obs[0].on_promo).toBe(true);
    expect(obs[1].on_promo).toBe(false);
    expect(obs[2].on_promo).toBe(false);
    expect(obs[0].price).toBe(2000); // the list price, not the discounted one
  });

  it("uses the price with the most units when several occur on one day, and totals all units", () => {
    const out = buildObservations(
      [
        line(0, { quantity: 2, unitPriceCents: 1800, discountedUnitPriceCents: 1800 }),
        line(0, { quantity: 5, unitPriceCents: 2000 }),
        line(0, { quantity: 1, unitPriceCents: 2200, discountedUnitPriceCents: 2200 }),
      ],
      range,
    );
    const first = (out.get("v1") ?? [])[0];
    expect(first.price).toBe(2000);
    expect(first.units).toBe(8);
  });

  it("breaks a units tie toward the lower price, deterministically", () => {
    const lines = [
      line(0, { quantity: 3, unitPriceCents: 2200, discountedUnitPriceCents: 2200 }),
      line(0, { quantity: 3, unitPriceCents: 2000 }),
    ];
    expect(buildObservations(lines, range).get("v1")?.[0].price).toBe(2000);
    expect(buildObservations([...lines].reverse(), range).get("v1")?.[0].price).toBe(2000);
  });

  it("tracks each variant's own start and ignores lines outside the range", () => {
    const out = buildObservations(
      [
        line(0, { variantId: "a" }),
        line(6, { variantId: "b" }),
        line(-3, { variantId: "c" }), // before the range
        line(12, { variantId: "d" }), // after the range
      ],
      range,
    );
    expect(out.get("a")?.length).toBe(10);
    expect(out.get("b")?.length).toBe(4);
    expect(out.has("c")).toBe(false);
    expect(out.has("d")).toBe(false);
  });

  it("skips refunded (zero quantity) and zero-price lines", () => {
    const out = buildObservations(
      [line(0, { quantity: 0 }), line(1, { unitPriceCents: 0, discountedUnitPriceCents: 0 })],
      range,
    );
    expect(out.size).toBe(0);
  });

  it("day boundaries are UTC", () => {
    const out = buildObservations(
      [line(0, { processedAt: "2026-10-01T23:59:59Z" }), line(0, { processedAt: "2026-10-02T00:00:01Z" })],
      range,
    );
    const obs = out.get("v1") ?? [];
    expect(obs[0].day).toBe(D0);
    expect(obs[1].day).toBe(D0 + 1);
    expect(obs[1].units).toBe(1);
  });
});
