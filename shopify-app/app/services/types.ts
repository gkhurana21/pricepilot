// The contract between the server side and the screens.
//
// Engine types mirror the JSON the Go engine (cmd/engine) emits, field for
// field. All money is integer cents and all rates are basis points (10000 =
// 100%). Nothing in TypeScript computes a price: these types only carry what
// the engine decided.

export type Cents = number;
export type BasisPoints = number;

// ---- engine wire types (snake_case, exactly as marshalled by Go) -----------

export interface Policy {
  id: string;
  version: number;
  margin_floor: {
    basis: "on_price" | "on_cost";
    rate: BasisPoints;
    absolute_floor: Cents;
  };
  respect_map: boolean;
  max_decrease_bp: BasisPoints;
  max_increase_bp: BasisPoints;
  hard_floor: Cents;
  hard_ceiling: Cents;
  velocity: {
    min_days_between_changes: number;
    max_changes_per_window: number;
    window_days: number;
  };
  exclusions: {
    sku_ids: string[] | null;
    tags: string[] | null;
    collections: string[] | null;
  };
  rounding: { modulus: Cents; residue: Cents; enabled: boolean };
  min_change_bp: BasisPoints;
  min_confidence_bp: BasisPoints;
  max_skus_changed_bp: BasisPoints;
}

export interface SKUState {
  id: string;
  variant_gid: string;
  current_price: Cents;
  unit_cost: Cents;
  map_price: Cents;
  tags: string[] | null;
  collections: string[] | null;
  last_price_change_at: string; // RFC 3339; "0001-01-01T00:00:00Z" = never
  changes_in_window: number;
  inventory_quantity: number;
}

export interface Signal {
  name: string;
  contribution_bp: BasisPoints;
  description: string;
}

export interface Proposal {
  sku_id: string;
  proposed_price: Cents;
  confidence_bp: BasisPoints;
  rationale: string;
  signals: Signal[] | null;
}

export interface Reason {
  rule: string;
  effect: "blocked" | "bound" | "clamped" | "info";
  message: string;
}

export interface Decision {
  sku_id: string;
  action: "approve" | "clamp" | "reject";
  current_price: Cents;
  proposed_price: Cents;
  final_price: Cents; // 0 if and only if action is "reject"
  lower_bound: Cents;
  upper_bound: Cents;
  delta_bp: BasisPoints;
  margin_bp: BasisPoints;
  reasons: Reason[] | null;
  signals: Signal[] | null;
}

export interface Summary {
  total: number;
  approved: number;
  clamped: number;
  rejected: number;
  blocked: number;
  increases: number;
  decreases: number;
  rejected_by_rule: Record<string, number>;
}

export interface DecideResult {
  policy_hash: string;
  decided_at: string;
  summary: Summary;
  decisions: Decision[];
}

export interface Observation {
  day: number; // days since 1970-01-01 UTC
  price: Cents;
  units: number;
  on_promo: boolean;
}

export interface EngineEstimate {
  elasticity: number | null;
  std_err: number | null;
  ci_low: number | null;
  ci_high: number | null;
  r_squared: number | null;
  shrinkage: number | null;
  level: number | null;
  mean_units_per_day: number | null;
  log_price_sd: number | null;
  days: number;
  zero_days: number;
  distinct_prices: number;
  promo_control: boolean;
  controls: string[];
  method: "ols" | "pooled" | "refused";
  refusal: string; // "" when the estimate is usable
  note: string;
  confidence_bp: BasisPoints;
}

export interface FitOptions {
  control_promo: boolean;
  weekly_seasonality: boolean;
  annual_seasonality: boolean;
  level: number;
  min_days: number;
  min_distinct_prices: number;
  min_log_price_sd: number;
  max_relative_half_width: number;
  min_mean_units_per_day: number;
}

export interface EstimateResult {
  options: FitOptions;
  results: {
    sku_id: string;
    estimate: EngineEstimate;
    proposal: Proposal | null;
    no_proposal_reason: string;
    no_proposal_code: string;
  }[];
}

// ---- what a screen renders -------------------------------------------------

// How a row ended up. "no_proposal" means the estimator declined, so the
// enforcer never saw it. The other three come from the enforcer's action:
// approve -> approved, clamp -> adjusted, reject -> held_back.
export type RowOutcome = "approved" | "adjusted" | "held_back" | "no_proposal";

export interface ReviewRow {
  skuId: string; // the engine's sku id; we use the variant GID
  variantId: string;
  productId: string;
  title: string; // "Product — Variant", or just the product title
  sku: string; // the merchant's SKU code, may be ""
  group: string; // pooling group (product type)
  tags: string[];
  currentPrice: Cents;
  unitCost: Cents | null; // null when the variant has no cost
  estimate: EngineEstimate;
  // Known only for seeded synthetic data; null on any real store.
  trueElasticity: number | null;
  proposal: Proposal | null;
  noProposalReason: string;
  noProposalCode: string;
  decision: Decision | null; // null when there was no proposal
  outcome: RowOutcome;
  // The rule a merchant should look at: for a reject, the last reason's rule;
  // for an adjusted row, the binding non-rounding rule (or "rounding").
  decidingRule: string | null;
}

export type RunStatus =
  | "PREVIEW" // decided and stored, nothing written to Shopify
  | "APPLIED"
  | "PARTIAL" // some variants failed or were skipped
  | "FAILED"
  | "ROLLED_BACK"
  | "ROLLBACK_PARTIAL";

// One variant's fate when a run was applied or rolled back.
export interface WriteItem {
  skuId: string;
  title: string;
  fromPrice: Cents;
  toPrice: Cents;
  // "applied", or why not: "stale_price" (the live price no longer matched the
  // price the decision was made against), "edited_since_apply" (rollback only),
  // or "api_error".
  status: "applied" | "stale_price" | "edited_since_apply" | "api_error";
  error: string | null;
  // Price read back from Shopify after the write; null if the re-read failed.
  livePriceAfter: Cents | null;
  verified: boolean; // livePriceAfter === toPrice
}

export interface WriteReport {
  at: string; // ISO time
  attempted: number;
  applied: number;
  skipped: number;
  failed: number;
  verified: number; // how many re-reads matched
  items: WriteItem[];
}

export interface DataBasis {
  synthetic: boolean; // true when the orders read carry the pricepilot-synthetic tag
  orderCount: number;
  firstDay: string | null; // YYYY-MM-DD (UTC)
  lastDay: string | null;
  days: number;
}

export interface RunView {
  id: string;
  shop: string;
  createdAt: string; // ISO
  status: RunStatus;
  policy: Policy;
  policyHash: string;
  options: FitOptions;
  dataBasis: DataBasis;
  summary: Summary; // the enforcer's own summary of the proposals it saw
  rows: ReviewRow[];
  apply: WriteReport | null;
  rollback: WriteReport | null;
}

export interface RunListItem {
  id: string;
  createdAt: string;
  status: RunStatus;
  policyId: string;
  policyVersion: number;
  policyHash: string;
  proposals: number;
  approved: number;
  adjusted: number;
  heldBack: number;
  applied: number; // variants written, 0 for a preview
  rolledBackAt: string | null;
}

// Minimal Admin GraphQL client, satisfied by `admin.graphql` from
// authenticate.admin and by a fake in tests.
export type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;
