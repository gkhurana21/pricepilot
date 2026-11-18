import { describe, expect, it } from "vitest";
import { boundByPolicy, decidingRule, outcomeCounts, outcomeOf } from "./rows";
import { fixtureRuns } from "../fixtures/runs";
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

// Each case mirrors enforcer/decision.go Decision.BoundByPolicy(): a reason
// with effect "clamped" from any rule except "rounding".
describe("boundByPolicy", () => {
  it("is true when a guardrail clamped the price", () => {
    expect(boundByPolicy(decision("clamp", [r("max_decrease", "clamped"), r("rounding", "clamped")]))).toBe(true);
    expect(boundByPolicy(decision("clamp", [r("margin_floor", "clamped")]))).toBe(true);
  });
  it("is false when only rounding clamped it", () => {
    expect(boundByPolicy(decision("clamp", [r("rounding", "clamped")]))).toBe(false);
  });
  it("ignores reasons that bound, blocked or informed without clamping", () => {
    expect(boundByPolicy(decision("clamp", [r("max_increase", "bound"), r("rounding", "clamped")]))).toBe(false);
    expect(boundByPolicy(decision("reject", [r("velocity_min_days", "blocked")]))).toBe(false);
    expect(boundByPolicy(decision("approve", [r("min_change", "info")]))).toBe(false);
  });
  it("is false with no reasons", () => {
    expect(boundByPolicy(decision("approve", null))).toBe(false);
    expect(boundByPolicy(decision("approve", []))).toBe(false);
  });
  it("looks only at the reasons, like the Go method", () => {
    // A reject can carry a clamp from before the rule that rejected it.
    expect(boundByPolicy(decision("reject", [r("margin_floor", "clamped"), r("min_change", "info")]))).toBe(true);
  });
});

describe("outcomeOf", () => {
  it("holds back every reject, whatever clamped before it", () => {
    expect(outcomeOf(decision("reject", []))).toBe("held_back");
    expect(outcomeOf(decision("reject", [r("margin_floor", "clamped"), r("min_change", "info")]))).toBe("held_back");
  });
  it("puts a clamp a guardrail made under adjusted", () => {
    expect(outcomeOf(decision("clamp", [r("max_decrease", "clamped"), r("rounding", "clamped")]))).toBe("adjusted");
  });
  it("accepts a clamp that only tidied the price ending, and every approval", () => {
    expect(outcomeOf(decision("clamp", [r("rounding", "clamped")]))).toBe("accepted");
    expect(outcomeOf(decision("clamp", [r("max_increase", "bound"), r("rounding", "clamped")]))).toBe("accepted");
    expect(outcomeOf(decision("approve", null))).toBe("accepted");
  });
});

describe("outcomeCounts", () => {
  it("counts each group, with no decision as no proposal", () => {
    expect(
      outcomeCounts([
        decision("approve", null),
        decision("clamp", [r("rounding", "clamped")]),
        decision("clamp", [r("max_decrease", "clamped")]),
        decision("reject", []),
        null,
      ]),
    ).toEqual({ accepted: 2, adjusted: 1, held_back: 1, no_proposal: 1 });
  });
});

describe("fixtures", () => {
  it("carry the group the engine's decision implies", () => {
    for (const run of Object.values(fixtureRuns)) {
      for (const row of run?.rows ?? []) {
        expect(row.outcome, row.title).toBe(row.decision ? outcomeOf(row.decision) : "no_proposal");
        expect(row.decidingRule, row.title).toBe(row.decision ? decidingRule(row.decision) : null);
      }
    }
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
