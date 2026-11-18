import { describe, expect, it } from "vitest";
import { formatCents, toCents, toCentsTruncated } from "./money";

describe("toCents", () => {
  it.each([
    ["21", 2100],
    ["21.5", 2150],
    ["21.50", 2150],
    ["21.500", 2150], // Shopify padding
    ["0.99", 99],
    ["0", 0],
    ["0.0", 0],
    ["9.0", 900],
  ])("converts %s", (input, expected) => {
    expect(toCents(input)).toBe(expected);
  });

  it("is exact where float multiplication is not", () => {
    // 1.005 * 100 === 100.49999999999999 and 0.29 * 100 === 28.999999999999996
    expect(toCents("0.29")).toBe(29);
    expect(toCents("1.15")).toBe(115);
    expect(toCents("4.35")).toBe(435);
  });

  it.each(["-1", "-0.5", "1.005", "1.005000", "21.999", "", " ", "abc", "1e3", "1,5", "$5", ".5", "5.", "1.2.3", " 5", "5 ", "+5", "NaN", "Infinity"])(
    "rejects %j",
    (input) => {
      expect(() => toCents(input)).toThrow();
    },
  );

  it("rejects non-strings", () => {
    expect(() => toCents(5 as unknown as string)).toThrow();
  });

  it("rejects amounts beyond safe integers", () => {
    expect(() => toCents("99999999999999999999")).toThrow();
  });
});

describe("toCentsTruncated", () => {
  it("drops sub-cent digits for comparison only", () => {
    expect(toCentsTruncated("8.4915")).toBe(849);
    expect(toCentsTruncated("21.5")).toBe(2150);
    expect(() => toCentsTruncated("-1")).toThrow();
  });
});

describe("formatCents", () => {
  it.each([
    [2150, "21.50"],
    [2100, "21.00"],
    [99, "0.99"],
    [5, "0.05"],
    [0, "0.00"],
    [123456, "1234.56"],
  ])("formats %d", (cents, expected) => {
    expect(formatCents(cents)).toBe(expected);
  });

  it("round-trips with toCents", () => {
    for (const c of [0, 1, 99, 100, 1999, 250000]) expect(toCents(formatCents(c))).toBe(c);
  });

  it.each([-1, 1.5, NaN])("rejects %s", (c) => {
    expect(() => formatCents(c)).toThrow();
  });
});
