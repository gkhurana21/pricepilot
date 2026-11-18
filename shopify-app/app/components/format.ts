// Pure formatting helpers. The UI never computes a price or a decision: every
// number on screen comes from the engine as integer cents or basis points, and
// this file only turns those integers into text. It is the one place where
// dividing by 100 is allowed.

import type {
  BasisPoints,
  Cents,
  Policy,
  ReviewRow,
  RowOutcome,
  RunStatus,
  Summary,
  WriteItem,
  WriteReport,
} from "../services/types";

const MINUS = "−"; // a real minus sign, not a hyphen

/** 1899 -> "$18.99"; -500 -> "−$5.00"; always two decimals. */
export function formatCents(cents: Cents | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) {
    return "—";
  }
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? MINUS : ""}$${grouped}.${rest}`;
}

/** 4812 -> "4,812". */
export function formatCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Basis points as a percentage with one decimal: 5380 -> "53.8%". */
export function formatBp(bp: BasisPoints | null | undefined): string {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return "—";
  const tenths = Math.round(Math.abs(bp) / 10);
  const text = `${Math.floor(tenths / 10)}.${tenths % 10}%`;
  return bp < 0 && tenths !== 0 ? `${MINUS}${text}` : text;
}

/** A signed change: -874 -> "−8.7%", 832 -> "+8.3%", 0 -> "0.0%". */
export function formatSignedBp(bp: BasisPoints | null | undefined): string {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return "—";
  const text = formatBp(bp);
  return bp > 0 && text !== "0.0%" ? `+${text}` : text;
}

/** Elasticity with a real minus sign: -2.4 -> "−2.40". */
export function formatElasticity(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const text = Math.abs(value).toFixed(2);
  return value < 0 && Number(text) !== 0 ? `${MINUS}${text}` : text;
}

/** "[−2.91, −1.68]" or "" when either end is missing. */
export function formatInterval(
  low: number | null | undefined,
  high: number | null | undefined,
): string {
  if (low === null || low === undefined || high === null || high === undefined) {
    return "";
  }
  return `[${formatElasticity(low)}, ${formatElasticity(high)}]`;
}

/** Shrinkage weight in [0,1] shown as a whole-number percent: 0.35 -> "35%". */
export function formatShare(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return `${Math.round(value * 100)}%`;
}

/** Units per day, one decimal. */
export function formatUnits(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return value.toFixed(1);
}

/** ISO instant -> "2026-08-16 14:02 UTC". Fixed zone so server and browser agree. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** "sha256:027a232f6814cd0b..." -> "027a232f6814". */
export function shortHash(hash: string): string {
  const bare = hash.includes(":") ? hash.slice(hash.indexOf(":") + 1) : hash;
  return bare.slice(0, 12);
}

const STATUS_LABELS: Record<RunStatus, string> = {
  PREVIEW: "Preview, not applied",
  APPLIED: "Applied",
  PARTIAL: "Partly applied",
  FAILED: "Failed",
  ROLLED_BACK: "Rolled back",
  ROLLBACK_PARTIAL: "Partly rolled back",
};

export function statusLabel(status: RunStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export type BadgeTone =
  | "auto"
  | "neutral"
  | "info"
  | "success"
  | "caution"
  | "warning"
  | "critical";

export function statusTone(status: RunStatus): BadgeTone {
  switch (status) {
    case "PREVIEW":
      return "info";
    case "APPLIED":
      return "success";
    case "PARTIAL":
    case "ROLLBACK_PARTIAL":
      return "warning";
    case "FAILED":
      return "critical";
    case "ROLLED_BACK":
      return "neutral";
    default:
      return "auto";
  }
}

export function outcomeTone(outcome: RowOutcome): BadgeTone {
  switch (outcome) {
    case "held_back":
      return "critical";
    case "adjusted":
      return "caution";
    case "approved":
      return "success";
    default:
      return "neutral";
  }
}

/** Marker and spoken label for a reason's effect. Never colour alone. */
export function reasonMarker(effect: string): { symbol: string; label: string } {
  switch (effect) {
    case "blocked":
      return { symbol: "×", label: "Blocked" };
    case "clamped":
      return { symbol: "→", label: "Adjusted" };
    case "bound":
      return { symbol: "·", label: "Bound" };
    default:
      return { symbol: "·", label: "Note" };
  }
}

/** True when the decision would write a different price to Shopify. */
export function isApplicable(row: ReviewRow): boolean {
  const d = row.decision;
  if (!d) return false;
  return (
    (d.action === "approve" || d.action === "clamp") &&
    d.final_price !== d.current_price
  );
}

/** How many price changes "Apply" would write. A count, not a price. */
export function countApplicable(rows: ReviewRow[]): number {
  return rows.filter(isApplicable).length;
}

export function rowsByOutcome(rows: ReviewRow[], outcome: RowOutcome): ReviewRow[] {
  return rows.filter((r) => r.outcome === outcome);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "13 products · 9 proposals · 2 approved · 3 adjusted · 4 held back · 4 no proposal" */
export function funnelLine(summary: Summary, rows: ReviewRow[]): string {
  const noProposal = rowsByOutcome(rows, "no_proposal").length;
  return [
    plural(rows.length, "product"),
    plural(summary.total, "proposal"),
    `${summary.approved} approved`,
    `${summary.clamped} adjusted`,
    `${summary.rejected} held back`,
    `${noProposal} no proposal`,
  ].join(" · ");
}

/** "7 written, 1 skipped, 0 failed · 7 of 7 verified by re-reading prices from Shopify" */
export function reportLine(report: WriteReport): string {
  return (
    `${report.applied} written, ${report.skipped} skipped, ${report.failed} failed` +
    ` · ${report.verified} of ${report.applied} verified by re-reading prices from Shopify`
  );
}

export function writeStatusLabel(item: WriteItem): string {
  switch (item.status) {
    case "applied":
      return "Applied";
    case "stale_price":
      return "Skipped: price changed since the preview";
    case "edited_since_apply":
      return "Skipped: price was edited after this run applied it";
    case "api_error":
      return item.error ? `Failed: ${item.error}` : "Failed: Shopify returned an error";
    default:
      return item.status;
  }
}

export function writeStatusTone(item: WriteItem): BadgeTone {
  if (item.status === "applied") return "success";
  if (item.status === "api_error") return "critical";
  return "caution";
}

/** The live price read back from Shopify, with an explicit verdict. */
export function verifiedLabel(item: WriteItem): string {
  if (item.livePriceAfter === null) return "Could not re-read from Shopify";
  const price = formatCents(item.livePriceAfter);
  if (item.status !== "applied") return `${price} live now (not written)`;
  return item.verified ? `${price} \u2713 verified` : `${price} \u26a0 does not match`;
}

export function marginFloorText(policy: Policy): string {
  const f = policy.margin_floor;
  const basis = f.basis === "on_price" ? "of price" : "of cost";
  const abs = f.absolute_floor > 0 ? `, at least ${formatCents(f.absolute_floor)} per unit` : "";
  return `${formatBp(f.rate)} ${basis}${abs}`;
}

export function roundingText(policy: Policy): string {
  const r = policy.rounding;
  if (!r.enabled) return "Off";
  return `Prices end in ${formatCents(r.residue)} within every ${formatCents(r.modulus)}`;
}

export function velocityText(policy: Policy): string {
  const v = policy.velocity;
  return (
    `At least ${plural(v.min_days_between_changes, "day")} between changes; ` +
    `at most ${plural(v.max_changes_per_window, "change")} per ${v.window_days}-day window`
  );
}

export function exclusionsText(policy: Policy): string {
  const e = policy.exclusions;
  const parts: string[] = [];
  if (e.tags?.length) parts.push(`tags: ${e.tags.join(", ")}`);
  if (e.collections?.length) parts.push(`collections: ${e.collections.join(", ")}`);
  if (e.sku_ids?.length) parts.push(plural(e.sku_ids.length, "individual SKU"));
  return parts.length ? parts.join("; ") : "None";
}

// Plain-language names for the engine's rule ids. The id itself is still shown
// beside the label, because it is what the audit log and the policy use.
const RULE_LABELS: Record<string, string> = {
  excluded: "Excluded by policy",
  min_confidence: "Estimate not confident enough",
  velocity_min_days: "Repriced too recently",
  velocity_max_changes: "Too many recent changes",
  margin_floor: "Margin floor",
  map: "Minimum advertised price",
  hard_floor: "Price floor",
  hard_ceiling: "Price ceiling",
  max_decrease: "Largest decrease per run",
  max_increase: "Largest increase per run",
  proposal_direction: "Direction of the proposal",
  rounding: "Price ending",
  infeasible_bounds: "Rules leave no valid price",
  no_change: "No change needed",
  min_change: "Change too small",
  invalid_input: "Invalid input",
  batch_change_budget: "Run change budget",
  too_few_days: "Not enough history",
  too_few_distinct_prices: "Never repriced enough",
  insufficient_price_variation: "Prices too similar",
  collinear_regressors: "Cannot separate the effects",
  not_distinguishable_from_zero: "No measurable price effect",
  implausible_positive_elasticity: "Demand rose with price",
  interval_too_wide: "Estimate too imprecise",
  volume_too_low: "Too few sales",
  no_proposal: "No proposal",
};

export function ruleLabel(rule: string | null | undefined): string {
  if (!rule) return "";
  return RULE_LABELS[rule] ?? rule;
}
