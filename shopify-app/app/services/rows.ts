// How an enforcer decision is labelled for a screen. Pure mapping: it reads
// what the engine decided and names it; it never changes a price.

import type { Decision, RowOutcome } from "./types";

// approve -> approved, clamp -> adjusted, reject -> held_back. A row with no
// proposal never reaches the enforcer and is "no_proposal" (set by the caller).
export function outcomeOf(decision: Decision): RowOutcome {
  switch (decision.action) {
    case "approve":
      return "approved";
    case "clamp":
      return "adjusted";
    case "reject":
      return "held_back";
  }
}

/**
 * The rule a merchant should look at: for a reject, the last reason's rule;
 * for an adjusted row, the binding non-rounding rule (the first reason with
 * effect "clamped" that is not rounding), or "rounding" when only rounding
 * moved the price. Approved rows have none.
 */
export function decidingRule(decision: Decision): string | null {
  const reasons = decision.reasons ?? [];
  if (decision.action === "reject") {
    return reasons.length > 0 ? reasons[reasons.length - 1].rule : null;
  }
  if (decision.action === "clamp") {
    const binding = reasons.find((r) => r.effect === "clamped" && r.rule !== "rounding");
    if (binding) return binding.rule;
    return reasons.some((r) => r.effect === "clamped" && r.rule === "rounding")
      ? "rounding"
      : null;
  }
  return null;
}
