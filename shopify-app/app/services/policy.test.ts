import { describe, expect, it } from "vitest";
import { policyHash } from "./engine.server";
import { BUILT_IN_POLICY, loadDefaultPolicy } from "./policy.server";

describe("default policy", () => {
  it("is accepted by the engine (strict decoding) and hashed by it", async () => {
    expect(await policyHash(loadDefaultPolicy())).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(await policyHash(BUILT_IN_POLICY)).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it("the built-in policy has the documented guardrails", () => {
    expect(BUILT_IN_POLICY).toMatchObject({
      margin_floor: { basis: "on_price", rate: 4000 },
      max_decrease_bp: 1500,
      max_increase_bp: 1000,
      rounding: { modulus: 100, residue: 99, enabled: true },
      min_change_bp: 200,
      min_confidence_bp: 6000,
      velocity: { min_days_between_changes: 14, max_changes_per_window: 2, window_days: 90 },
      exclusions: { tags: ["subscription"] },
    });
  });
});
