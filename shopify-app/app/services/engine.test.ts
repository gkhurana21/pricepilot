import { describe, expect, it } from "vitest";
import { callEngine, decide, enginePath, estimate, policyHash } from "./engine.server";
import { BUILT_IN_POLICY } from "./policy.server";
import type { SKUState } from "./types";

const sku: SKUState = {
  id: "a",
  variant_gid: "gid://shopify/ProductVariant/1",
  current_price: 1850,
  unit_cost: 900,
  map_price: 0,
  tags: [],
  collections: ["retail-beans"],
  last_price_change_at: "0001-01-01T00:00:00Z",
  changes_in_window: 0,
  inventory_quantity: 40,
};

describe("engine client (real binary)", () => {
  it("policy_hash returns a sha256 hash", async () => {
    expect(await policyHash(BUILT_IN_POLICY)).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it("decide on a tiny request returns the engine's policy hash and a decision", async () => {
    const result = await decide({
      policy: BUILT_IN_POLICY,
      now: "2026-11-18T09:00:00Z",
      items: [
        {
          sku,
          proposal: {
            sku_id: "a",
            proposed_price: 1990,
            confidence_bp: 9000,
            rationale: "test",
            signals: [],
          },
        },
      ],
    });
    expect(result.policy_hash).toBe(await policyHash(BUILT_IN_POLICY));
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].sku_id).toBe("a");
    expect(result.summary.total).toBe(1);
  });

  it("estimate refuses a SKU with no history rather than inventing a number", async () => {
    const result = await estimate([{ sku, group: "retail-beans", observations: [] }]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].estimate.method).toBe("refused");
    expect(result.results[0].proposal).toBeNull();
  });

  it("decide with no items is accepted", async () => {
    const result = await decide({ policy: BUILT_IN_POLICY, now: "2026-11-18T09:00:00Z", items: [] });
    expect(result.decisions).toEqual([]);
    expect(result.summary.total).toBe(0);
  });

  it("surfaces the engine's own message for a bad request", async () => {
    await expect(callEngine("decide", { policy: BUILT_IN_POLICY, items: [] })).rejects.toThrow(
      /decide/,
    );
    await expect(callEngine("decide", { nope: 1 })).rejects.toThrow(/unknown field/);
  });

  it("rejects an unknown op with the engine's list of valid ops", async () => {
    await expect(callEngine("frobnicate" as never, {})).rejects.toThrow(/valid ops/);
  });

  it("throws a clear build instruction when the binary is missing, and never decides in TS", async () => {
    await expect(
      callEngine("policy_hash", {}, { binary: "/nonexistent/engine" }),
    ).rejects.toThrow(/npm run engine:build/);
  });

  it("honours PRICEPILOT_ENGINE", () => {
    const old = process.env.PRICEPILOT_ENGINE;
    process.env.PRICEPILOT_ENGINE = "/somewhere/engine";
    try {
      expect(enginePath()).toBe("/somewhere/engine");
    } finally {
      if (old === undefined) delete process.env.PRICEPILOT_ENGINE;
      else process.env.PRICEPILOT_ENGINE = old;
    }
  });

  it("times out a hung engine", async () => {
    // `sleep` is not an engine, but it behaves like a hung one: it never answers.
    await expect(
      callEngine("policy_hash", {}, { binary: "/bin/sleep", timeoutMs: 200 }),
    ).rejects.toThrow(/timed out|no output/);
  });
});
