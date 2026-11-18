// Typed fixtures for the preview route and for tests. Every run satisfies
// RunView exactly, so the compiler checks them against the contract. The
// numbers are data, as the engine would have produced them; nothing here is
// computed at render time. Wording of the reasons is taken from the Go demo
// (`go run ./cmd/demo`).

import type {
  Decision,
  EngineEstimate,
  FitOptions,
  Policy,
  Reason,
  ReviewRow,
  RunView,
  Summary,
  WriteItem,
  WriteReport,
} from "../services/types";

const POLICY_HASH = "sha256:027a232f6814cd0b";
const SHOP = "bramble-coffee.myshopify.com";

export const fixturePolicy: Policy = {
  id: "pol_bramble_coffee",
  version: 4,
  margin_floor: { basis: "on_price", rate: 4000, absolute_floor: 0 },
  respect_map: true,
  max_decrease_bp: 1500,
  max_increase_bp: 1000,
  hard_floor: 100,
  hard_ceiling: 100000,
  velocity: { min_days_between_changes: 14, max_changes_per_window: 2, window_days: 90 },
  exclusions: { sku_ids: null, tags: ["subscription"], collections: null },
  rounding: { modulus: 100, residue: 99, enabled: true },
  min_change_bp: 200,
  min_confidence_bp: 6000,
  max_skus_changed_bp: 10000,
};

const options: FitOptions = {
  control_promo: true,
  weekly_seasonality: true,
  annual_seasonality: false,
  level: 0.95,
  min_days: 60,
  min_distinct_prices: 4,
  min_log_price_sd: 0.02,
  max_relative_half_width: 0.5,
  min_mean_units_per_day: 1,
};

function est(over: Partial<EngineEstimate>): EngineEstimate {
  return {
    elasticity: null,
    std_err: null,
    ci_low: null,
    ci_high: null,
    r_squared: null,
    shrinkage: null,
    level: 0.95,
    mean_units_per_day: null,
    log_price_sd: null,
    days: 180,
    zero_days: 0,
    distinct_prices: 6,
    promo_control: true,
    controls: ["weekday"],
    method: "ols",
    refusal: "",
    note: "",
    confidence_bp: 0,
    ...over,
  };
}

interface RowArgs {
  n: number;
  title: string;
  sku: string;
  group: string;
  tags?: string[];
  currentPrice: number;
  unitCost: number | null;
  estimate: EngineEstimate;
  trueElasticity: number | null;
  proposed?: { price: number; confidence: number; rationale: string };
  noProposalReason?: string;
  noProposalCode?: string;
  decision?: Decision;
  outcome: ReviewRow["outcome"];
  decidingRule: string | null;
}

function row(a: RowArgs): ReviewRow {
  const gid = `gid://shopify/ProductVariant/${4400100 + a.n}`;
  return {
    skuId: gid,
    variantId: gid,
    productId: `gid://shopify/Product/${9100100 + a.n}`,
    title: a.title,
    sku: a.sku,
    group: a.group,
    tags: a.tags ?? [],
    currentPrice: a.currentPrice,
    unitCost: a.unitCost,
    estimate: a.estimate,
    trueElasticity: a.trueElasticity,
    proposal: a.proposed
      ? {
          sku_id: gid,
          proposed_price: a.proposed.price,
          confidence_bp: a.proposed.confidence,
          rationale: a.proposed.rationale,
          signals: null,
        }
      : null,
    noProposalReason: a.noProposalReason ?? "",
    noProposalCode: a.noProposalCode ?? "",
    decision: a.decision ? { ...a.decision, sku_id: gid } : null,
    outcome: a.outcome,
    decidingRule: a.decidingRule,
  };
}

function decision(d: Omit<Decision, "sku_id" | "signals">): Decision {
  return { sku_id: "", signals: null, ...d };
}

const rule = (r: string, effect: Reason["effect"], message: string): Reason => ({
  rule: r,
  effect,
  message,
});

// ---- held back --------------------------------------------------------------

const monthly = row({
  n: 1,
  title: "Monthly Roaster's Pick",
  sku: "SUB-MRP-1",
  group: "subscription",
  tags: ["subscription"],
  currentPrice: 2400,
  unitCost: 1100,
  estimate: est({ elasticity: -2.05, std_err: 0.4, ci_low: -2.84, ci_high: -1.26, mean_units_per_day: 3.2, confidence_bp: 7800 }),
  trueElasticity: -2.1,
  proposed: { price: 2000, confidence: 7800, rationale: "elasticity -2.05 implies a margin-optimal price of $20.00 against a $11.00 unit cost" },
  decision: decision({
    action: "reject",
    current_price: 2400,
    proposed_price: 2000,
    final_price: 0,
    lower_bound: 0,
    upper_bound: 0,
    delta_bp: 0,
    margin_bp: 0,
    reasons: [rule("excluded", "blocked", 'SKU is excluded by tag "subscription"')],
  }),
  outcome: "held_back",
  decidingRule: "excluded",
});

const baratza = row({
  n: 2,
  title: "Baratza Encore Grinder",
  sku: "GRN-ENC",
  group: "equipment",
  currentPrice: 17900,
  unitCost: 12500,
  estimate: est({ elasticity: -2.62, std_err: 0.5, ci_low: -3.6, ci_high: -1.64, mean_units_per_day: 1.4, confidence_bp: 7200 }),
  trueElasticity: -2.5,
  proposed: { price: 16500, confidence: 7200, rationale: "elasticity -2.62 implies a margin-optimal price of $165.00 against a $125.00 unit cost" },
  decision: decision({
    action: "reject",
    current_price: 17900,
    proposed_price: 16500,
    final_price: 0,
    lower_bound: 20834,
    upper_bound: 19690,
    delta_bp: 0,
    margin_bp: 0,
    reasons: [
      rule(
        "infeasible_bounds",
        "blocked",
        "the current price $179.00 is below the floor of $208.34 set by margin_floor, so a decrease proposal cannot be applied; raise the price to the floor or relax margin_floor",
      ),
    ],
  }),
  outcome: "held_back",
  decidingRule: "infeasible_bounds",
});

const chemex = row({
  n: 3,
  title: "Chemex Classic 6-cup",
  sku: "BRW-CHX6",
  group: "equipment",
  currentPrice: 5200,
  unitCost: 3100,
  estimate: est({ elasticity: -1.9, std_err: 0.3, ci_low: -2.5, ci_high: -1.3, mean_units_per_day: 2.1, confidence_bp: 8100 }),
  trueElasticity: -1.8,
  proposed: { price: 4200, confidence: 8100, rationale: "elasticity -1.90 implies a margin-optimal price of $42.00 against a $31.00 unit cost" },
  decision: decision({
    action: "reject",
    current_price: 5200,
    proposed_price: 4200,
    final_price: 0,
    lower_bound: 5167,
    upper_bound: 5720,
    delta_bp: 0,
    margin_bp: 0,
    reasons: [
      rule("margin_floor", "clamped", "proposed $42.00 raised to $51.67 by the binding lower bound"),
      rule("rounding", "clamped", "rounded $51.67 to $51.99, the nearest permitted ending that does not go past the proposal"),
      rule("min_change", "info", "$52.00 to $51.99 is a −0.02% move, below the 2.00% worth applying"),
    ],
  }),
  outcome: "held_back",
  decidingRule: "min_change",
});

const kenya = row({
  n: 4,
  title: "Kenya Nyeri AA 250g",
  sku: "COF-KEN-250",
  group: "coffee",
  currentPrice: 2600,
  unitCost: 1200,
  estimate: est({ elasticity: -2.3, std_err: 0.35, ci_low: -3.0, ci_high: -1.6, mean_units_per_day: 5.8, confidence_bp: 8800 }),
  trueElasticity: -2.4,
  proposed: { price: 2400, confidence: 8800, rationale: "elasticity -2.30 implies a margin-optimal price of $24.00 against a $12.00 unit cost" },
  decision: decision({
    action: "reject",
    current_price: 2600,
    proposed_price: 2400,
    final_price: 0,
    lower_bound: 2210,
    upper_bound: 2860,
    delta_bp: 0,
    margin_bp: 0,
    reasons: [
      rule(
        "velocity_min_days",
        "blocked",
        "last repriced 2026-08-11; policy requires 14 days between changes (next eligible 2026-08-25)",
      ),
    ],
  }),
  outcome: "held_back",
  decidingRule: "velocity_min_days",
});

// ---- adjusted by a guardrail ------------------------------------------------

const bramble = row({
  n: 5,
  title: "Bramble House Blend 1kg",
  sku: "COF-BHB-1K",
  group: "coffee",
  currentPrice: 4800,
  unitCost: 2400,
  estimate: est({ elasticity: -1.8, std_err: 0.25, ci_low: -2.29, ci_high: -1.31, mean_units_per_day: 9.6, confidence_bp: 9100 }),
  trueElasticity: -1.8,
  proposed: { price: 5400, confidence: 9100, rationale: "elasticity -1.80 implies a margin-optimal price of $54.00 against a $24.00 unit cost" },
  decision: decision({
    action: "clamp",
    current_price: 4800,
    proposed_price: 5400,
    final_price: 5199,
    lower_bound: 4080,
    upper_bound: 5280,
    delta_bp: 832,
    margin_bp: 5384,
    reasons: [
      rule("max_increase", "clamped", "proposed $54.00 lowered to $52.80 by the binding upper bound"),
      rule("rounding", "clamped", "rounded $52.80 to $51.99, the nearest permitted ending that does not go past the proposal"),
    ],
  }),
  outcome: "adjusted",
  decidingRule: "max_increase",
});

// ---- accepted ---------------------------------------------------------------
// A clamp whose only clamped reason is rounding is accepted: the engine's
// BoundByPolicy() is false for it (see services/rows.ts).

const decaf = row({
  n: 6,
  title: "Decaf Swiss Water 250g",
  sku: "COF-DEC-250",
  group: "coffee",
  currentPrice: 2300,
  unitCost: 1150,
  estimate: est({
    elasticity: -2.28,
    std_err: 0.52,
    ci_low: -3.3,
    ci_high: -1.26,
    shrinkage: 0.35,
    mean_units_per_day: 2.7,
    method: "pooled",
    confidence_bp: 7000,
  }),
  trueElasticity: -2.4,
  proposed: { price: 2050, confidence: 7000, rationale: "elasticity -2.28 implies a margin-optimal price of $20.50 against a $11.50 unit cost" },
  decision: decision({
    action: "clamp",
    current_price: 2300,
    proposed_price: 2050,
    final_price: 2099,
    lower_bound: 1955,
    upper_bound: 2530,
    delta_bp: -874,
    margin_bp: 4521,
    reasons: [rule("rounding", "clamped", "rounded $20.50 to $20.99, the nearest permitted ending that does not go past the proposal")],
  }),
  outcome: "accepted",
  decidingRule: "rounding",
});

const peru = row({
  n: 7,
  title: "Peru Cajamarca 250g",
  sku: "COF-PER-250",
  group: "coffee",
  currentPrice: 2000,
  unitCost: 800,
  estimate: est({ elasticity: -2.14, std_err: 0.3, ci_low: -2.73, ci_high: -1.55, mean_units_per_day: 4.9, confidence_bp: 8600 }),
  trueElasticity: -2.2,
  proposed: { price: 1500, confidence: 8600, rationale: "elasticity -2.14 implies a margin-optimal price of $15.00 against a $8.00 unit cost" },
  decision: decision({
    action: "clamp",
    current_price: 2000,
    proposed_price: 1500,
    final_price: 1799,
    lower_bound: 1700,
    upper_bound: 2200,
    delta_bp: -1005,
    margin_bp: 5553,
    reasons: [
      rule("max_decrease", "clamped", "proposed $15.00 raised to $17.00 by the binding lower bound"),
      rule("rounding", "clamped", "rounded $17.00 to $17.99, the nearest permitted ending that does not go past the proposal"),
    ],
  }),
  outcome: "adjusted",
  decidingRule: "max_decrease",
});

const ethiopia = row({
  n: 8,
  title: "Ethiopia Yirgacheffe 250g",
  sku: "COF-ETH-250",
  group: "coffee",
  currentPrice: 2200,
  unitCost: 1100,
  estimate: est({ elasticity: -2.38, std_err: 0.31, ci_low: -2.99, ci_high: -1.77, mean_units_per_day: 7.4, confidence_bp: 9300 }),
  trueElasticity: -2.4,
  proposed: { price: 1899, confidence: 9300, rationale: "elasticity -2.38 implies a margin-optimal price of $18.99 against a $11.00 unit cost" },
  decision: decision({
    action: "approve",
    current_price: 2200,
    proposed_price: 1899,
    final_price: 1899,
    lower_bound: 1870,
    upper_bound: 2420,
    delta_bp: -1369,
    margin_bp: 4207,
    reasons: null,
  }),
  outcome: "accepted",
  decidingRule: null,
});

const sumatra = row({
  n: 9,
  title: "Sumatra Mandheling 250g",
  sku: "COF-SUM-250",
  group: "coffee",
  currentPrice: 1999,
  unitCost: 900,
  estimate: est({ elasticity: -1.75, std_err: 0.22, ci_low: -2.18, ci_high: -1.32, mean_units_per_day: 6.1, confidence_bp: 9000 }),
  trueElasticity: null,
  proposed: { price: 2099, confidence: 9000, rationale: "elasticity -1.75 implies a margin-optimal price of $20.99 against a $9.00 unit cost" },
  decision: decision({
    action: "approve",
    current_price: 1999,
    proposed_price: 2099,
    final_price: 2099,
    lower_bound: 1699,
    upper_bound: 2198,
    delta_bp: 500,
    margin_bp: 5712,
    reasons: null,
  }),
  outcome: "accepted",
  decidingRule: null,
});

// ---- no proposal ------------------------------------------------------------

const coldBrew = row({
  n: 10,
  title: "Cold Brew Concentrate",
  sku: "RTD-CB-1L",
  group: "ready-to-drink",
  currentPrice: 1500,
  unitCost: 600,
  estimate: est({
    method: "refused",
    refusal: "too_few_distinct_prices",
    distinct_prices: 2,
    mean_units_per_day: 3.6,
    note: "only 2 distinct prices in 180 days; at least 4 are needed to separate the effect of price from everything else that moves demand",
  }),
  trueElasticity: null,
  noProposalCode: "too_few_distinct_prices",
  noProposalReason:
    "only 2 distinct prices in 180 days; at least 4 are needed to separate the effect of price from everything else that moves demand",
  outcome: "no_proposal",
  decidingRule: null,
});

const hario = row({
  n: 11,
  title: "Hario V60 Filters 100ct",
  sku: "BRW-V60-F100",
  group: "equipment",
  currentPrice: 1200,
  unitCost: 500,
  estimate: est({
    method: "refused",
    refusal: "volume_too_low",
    mean_units_per_day: 0.4,
    zero_days: 121,
    note: "mean 0.4 units/day is below the 1.0 the estimator needs; a slow seller is mostly noise",
  }),
  trueElasticity: null,
  noProposalCode: "volume_too_low",
  noProposalReason: "mean 0.4 units/day is below the 1.0 the estimator needs; a slow seller is mostly noise",
  outcome: "no_proposal",
  decidingRule: null,
});

const guatemala = row({
  n: 12,
  title: "Guatemala Antigua 250g",
  sku: "COF-GUA-250",
  group: "coffee",
  currentPrice: 2100,
  unitCost: 1450,
  estimate: est({ elasticity: -1.75, std_err: 0.44, ci_low: -2.62, ci_high: -0.88, mean_units_per_day: 3.9, confidence_bp: 5200 }),
  trueElasticity: -1.5,
  noProposalCode: "interval_too_wide",
  noProposalReason: "interval [−2.62, −0.88] reaches the inelastic region where no profit-maximising price exists",
  outcome: "no_proposal",
  decidingRule: null,
});

const burundi = row({
  n: 13,
  title: "Burundi Kayanza 250g",
  sku: "COF-BUR-250",
  group: "coffee",
  currentPrice: 2350,
  unitCost: null,
  estimate: est({ elasticity: -2.2, std_err: 0.4, ci_low: -3.0, ci_high: -1.4, mean_units_per_day: 2.3, confidence_bp: 7500 }),
  trueElasticity: null,
  noProposalCode: "",
  noProposalReason: "no unit cost on this variant, so there is no margin to optimise",
  outcome: "no_proposal",
  decidingRule: null,
});

const rows: ReviewRow[] = [
  monthly, baratza, chemex, kenya,
  bramble, peru,
  decaf, ethiopia, sumatra,
  coldBrew, hario, guatemala, burundi,
];

const summary: Summary = {
  total: 9,
  approved: 2,
  clamped: 3,
  rejected: 4,
  blocked: 3,
  increases: 2,
  decreases: 7,
  rejected_by_rule: { excluded: 1, infeasible_bounds: 1, min_change: 1, velocity_min_days: 1 },
};

const base = {
  shop: SHOP,
  policy: fixturePolicy,
  policyHash: POLICY_HASH,
  options,
  dataBasis: {
    synthetic: true,
    orderCount: 4812,
    firstDay: "2026-02-17",
    lastDay: "2026-08-15",
    days: 180,
  },
  summary,
  rows,
  writeStartedAt: null,
  interrupted: false,
};

function item(
  r: ReviewRow,
  over: Partial<WriteItem> & Pick<WriteItem, "status">,
): WriteItem {
  const d = r.decision as Decision;
  return {
    skuId: r.skuId,
    title: r.title,
    fromPrice: d.current_price,
    toPrice: d.final_price,
    error: null,
    livePriceAfter: d.final_price,
    verified: true,
    ...over,
  };
}

const applyItems: WriteItem[] = [
  item(ethiopia, { status: "applied" }),
  item(bramble, { status: "applied" }),
  item(decaf, { status: "applied" }),
  item(sumatra, { status: "applied" }),
  item(peru, { status: "stale_price", livePriceAfter: 1950, verified: false }),
];

const applyReport: WriteReport = {
  at: "2026-08-16T14:31:07Z",
  attempted: 5,
  applied: 4,
  skipped: 1,
  failed: 0,
  verified: 4,
  items: applyItems,
};

export const previewRun = {
  id: "run_01HXPREVIEW",
  createdAt: "2026-08-16T14:02:11Z",
  status: "PREVIEW",
  ...base,
  apply: null,
  rollback: null,
} satisfies RunView;

export const appliedRun = {
  id: "run_01HXAPPLIED",
  createdAt: "2026-08-16T14:02:11Z",
  status: "APPLIED",
  ...base,
  apply: applyReport,
  rollback: null,
} satisfies RunView;

export const partialRun = {
  id: "run_01HXPARTIAL",
  createdAt: "2026-08-16T14:02:11Z",
  status: "PARTIAL",
  ...base,
  apply: {
    at: "2026-08-16T14:31:07Z",
    attempted: 5,
    applied: 4,
    skipped: 0,
    failed: 1,
    verified: 4,
    items: [
      item(ethiopia, { status: "applied" }),
      item(bramble, { status: "applied" }),
      item(decaf, { status: "applied" }),
      item(peru, { status: "applied" }),
      item(sumatra, {
        status: "api_error",
        error: "Shopify throttled the request (THROTTLED); the price was not changed",
        livePriceAfter: 1999,
        verified: false,
      }),
    ],
  },
  rollback: null,
} satisfies RunView;

function restored(r: ReviewRow, over: Partial<WriteItem> = {}): WriteItem {
  const d = r.decision as Decision;
  return {
    skuId: r.skuId,
    title: r.title,
    fromPrice: d.final_price,
    toPrice: d.current_price,
    status: "applied",
    error: null,
    livePriceAfter: d.current_price,
    verified: true,
    ...over,
  };
}

export const rolledBackRun = {
  id: "run_01HXROLLED",
  createdAt: "2026-08-16T14:02:11Z",
  status: "ROLLED_BACK",
  ...base,
  apply: applyReport,
  rollback: {
    at: "2026-08-17T09:12:40Z",
    attempted: 4,
    applied: 4,
    skipped: 0,
    failed: 0,
    verified: 4,
    items: [restored(ethiopia), restored(bramble), restored(decaf), restored(sumatra)],
  },
} satisfies RunView;

// A rollback that left one variant alone because it was edited since: the
// screen offers "Roll back the rest".
export const rollbackPartialRun = {
  ...rolledBackRun,
  id: "run_01HXROLLBACKPARTIAL",
  status: "ROLLBACK_PARTIAL",
  rollback: {
    at: "2026-08-17T09:12:40Z",
    attempted: 4,
    applied: 3,
    skipped: 1,
    failed: 0,
    verified: 3,
    items: [
      restored(ethiopia, {
        status: "edited_since_apply",
        error: "Live price is 1850 cents, not the 1899 this run applied; left alone.",
        livePriceAfter: 1850,
        verified: false,
      }),
      restored(bramble),
      restored(decaf),
      restored(sumatra),
    ],
  },
} satisfies RunView;

// The process died after sending prices and before saving the result.
export const interruptedRun = {
  id: "run_01HXINTERRUPTED",
  createdAt: "2026-08-16T14:02:11Z",
  status: "APPLYING",
  ...base,
  apply: null,
  rollback: null,
  writeStartedAt: "2026-08-16T14:31:02Z",
  interrupted: true,
} satisfies RunView;

// A write still within its heartbeat window.
export const applyingRun = {
  ...interruptedRun,
  id: "run_01HXAPPLYING",
  interrupted: false,
} satisfies RunView;

// What recoverRun rebuilt for the interrupted run above: two prices landed,
// one never changed, one was edited by someone else in the meantime.
export const recoveredRun = {
  id: "run_01HXRECOVERED",
  createdAt: "2026-08-16T14:02:11Z",
  status: "PARTIAL",
  ...base,
  apply: {
    at: "2026-08-16T14:52:40Z",
    attempted: 5,
    applied: 2,
    skipped: 1,
    failed: 2,
    verified: 2,
    recovered: true,
    items: [
      item(bramble, { status: "applied" }),
      item(peru, { status: "applied" }),
      item(decaf, {
        status: "not_written",
        error: "The write was interrupted before this price changed.",
        livePriceAfter: 2300,
        verified: false,
      }),
      item(ethiopia, {
        status: "edited_since_apply",
        error:
          "Live price is 1950 cents: neither the 2200 before this write nor the 1899 it set. It was changed outside this write; left alone.",
        livePriceAfter: 1950,
        verified: false,
      }),
      item(sumatra, {
        status: "not_written",
        error: "The write was interrupted before this price changed.",
        livePriceAfter: 1999,
        verified: false,
      }),
    ],
  },
  rollback: null,
} satisfies RunView;

export const fixtureRuns = {
  preview: previewRun as RunView,
  applied: appliedRun as RunView,
  partial: partialRun as RunView,
  rolledback: rolledBackRun as RunView,
  rollbackpartial: rollbackPartialRun as RunView,
  applying: applyingRun as RunView,
  interrupted: interruptedRun as RunView,
  recovered: recoveredRun as RunView,
  empty: null,
} as const;

export type FixtureState = keyof typeof fixtureRuns;
