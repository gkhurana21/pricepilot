// How an enforcer decision is grouped and labelled for a screen. Pure mapping:
// it reads what the engine decided and names it; it never changes a price and
// never makes a decision of its own.

import type { Decision, RowOutcome } from "./types";

/**
 * Mirrors enforcer/decision.go `Decision.BoundByPolicy()` exactly: true when
 * some reason has effect "clamped" from a rule other than "rounding", i.e. a
 * guardrail overrode the proposal rather than the price ending being tidied.
 * Like the Go method it looks only at the reasons, not at the action.
 */
export function boundByPolicy(decision: Decision): boolean {
  return (decision.reasons ?? []).some((r) => r.effect === "clamped" && r.rule !== "rounding");
}

/**
 * The group a decided row is shown in. This is a display grouping derived from
 * the engine's own action and reasons, not a new decision:
 *   reject                      -> held_back
 *   BoundByPolicy() is true     -> adjusted ("Adjusted by a guardrail")
 *   anything else               -> accepted (an approval, or a clamp that only
 *                                  rounded the price to the policy's ending)
 * With a price-ending rule on, nearly every proposal is technically a clamp,
 * so grouping by action alone would put everything under "adjusted". The Go
 * engine draws the same line for the same reason.
 * A row with no proposal never reaches the enforcer: the caller sets "no_proposal".
 */
export function outcomeOf(decision: Decision): RowOutcome {
  if (decision.action === "reject") return "held_back";
  return boundByPolicy(decision) ? "adjusted" : "accepted";
}

/**
 * The rule a merchant should look at: for a reject, the last reason's rule;
 * for a clamp, the binding non-rounding rule (the first reason with effect
 * "clamped" that is not rounding), or "rounding" when only rounding moved the
 * price. Untouched approvals have none.
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

/** Counts per group, as shown in the funnel line and the run history. */
export function outcomeCounts(
  decisions: (Decision | null)[],
): Record<RowOutcome, number> {
  const counts: Record<RowOutcome, number> = {
    accepted: 0,
    adjusted: 0,
    held_back: 0,
    no_proposal: 0,
  };
  for (const d of decisions) counts[d ? outcomeOf(d) : "no_proposal"]++;
  return counts;
}
