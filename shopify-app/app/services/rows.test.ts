import { describe, expect, it } from "vitest";
import { decidingRule, outcomeOf } from "./rows";
import type { Decision, Reason } from "./types";

function decision(action: Decision["action"], reasons: Reason[] | null): Decision {
  return {
    sku_id: "a",
    action,
    current_price: 1000,
    proposed_price: 1100,
    final_price: action === "reject" ? 0 : 1099,
    lower_bound: 0,
    upper_bound: 0,
    delta_bp: 0,
    margin_bp: 0,
    reasons,
    signals: null,
  };
}
const r = (rule: string, effect: Reason["effect"]): Reason => ({ rule, effect, message: "" });

describe("outcomeOf", () => {
  it("maps the enforcer's action", () => {
    expect(outcomeOf(decision("approve", []))).toBe("approved");
    expect(outcomeOf(decision("clamp", []))).toBe("adjusted");
    expect(outcomeOf(decision("reject", []))).toBe("held_back");
  });
});

describe("decidingRule", () => {
  it("is the last reason's rule for a reject", () => {
    expect(
      decidingRule(decision("reject", [r("min_confidence", "info"), r("velocity_min_days", "blocked")])),
    ).toBe("velocity_min_days");
    expect(decidingRule(decision("reject", null))).toBeNull();
  });
  it("is the binding non-rounding rule for an adjusted row", () => {
    expect(
      decidingRule(
        decision("clamp", [r("margin_floor", "bound"), r("max_increase", "clamped"), r("rounding", "clamped")]),
      ),
    ).toBe("max_increase");
  });
  it("is rounding when only rounding moved the price", () => {
    expect(
      decidingRule(decision("clamp", [r("max_increase", "bound"), r("rounding", "clamped")])),
    ).toBe("rounding");
  });
  it("is null for an approval", () => {
    expect(decidingRule(decision("approve", [r("rounding", "info")]))).toBeNull();
  });
});
