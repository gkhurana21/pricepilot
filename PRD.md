# PricePilot — Product Requirements Document

**An agentic repricing system for Shopify merchants, where a deterministic policy engine holds final authority over every price change.**

| | |
|---|---|
| Status | v1.1 — phases 1 and 2 built |
| Owner | Gaurang Khurana |
| Builds on | [BulkPilot](https://github.com/gkhurana21/bulkpilot) — embedded Shopify app, OAuth, `productVariantsBulkUpdate`, snapshot rollback |
| Target | Shopify SWE / Data co-op application |

---

## 1. Summary

Merchants change prices constantly — markdowns, competitor moves, aging inventory, margin pressure — and almost all of it is manual guesswork in a spreadsheet. Tools that automate it ask merchants to trust a black box with the single most dangerous field in their catalog.

PricePilot proposes price changes from demand signals, then puts every proposal through a **deterministic policy engine** that the model cannot override: margin floors, MAP compliance, maximum change per cycle, repricing velocity caps, exclusion lists, and rounding rules. Each proposal is **approved, clamped, or rejected with a stated reason**, previewed before it applies, and reversible in one click.

**Positioning:** *The agent suggests. The rules decide. You can always undo.*

---

## 2. Why this problem

Pricing is the highest-leverage lever a merchant has and the one they touch most nervously. A 1% price improvement moves profit far more than a 1% traffic improvement, but a bad automated markdown can destroy a month's margin before anyone notices.

The category's failure mode is trust, not accuracy. Existing repricers either:
- **Fully automate** and merchants disable them after one bad week, or
- **Only advise**, leaving the merchant with the same spreadsheet work

Neither addresses the real requirement: *let me delegate the work without delegating the authority.*

---

## 3. The architecture that makes it defensible

This is the core of the project and the reason it exists.

```
   demand signals            PROPOSER                 ENFORCER              APPLY
  ─────────────────       ──────────────          ─────────────────      ──────────
  order history  ─┐                                ┌───────────────┐
  inventory age   ├──→  elasticity model    ──→    │ margin floor  │ ──→  preview
  margin targets  │     + LLM rationale            │ MAP / min-adv │      snapshot
  competitor set ─┘     (proposes Δprice)          │ max Δ / cycle │      bulk apply
                                                   │ velocity cap  │      rollback
                                                   │ exclusions    │
                                                   │ rounding      │
                                                   └───────────────┘
                                                    approve │ clamp │ reject + reason
```

**The enforcer is pure, deterministic, and independently testable.** It takes a proposal and a policy, returns a decision and a reason string. No model call, no network, no randomness — so it can be property-tested against invariants:

- no approved change ever prices below the margin floor
- no approved change exceeds the per-cycle delta cap
- a SKU on the exclusion list is never modified
- applying the full decision set never violates the velocity cap
- every rejection carries a reason that names the rule it failed
- a price that changes moves the way the proposal pointed, never the opposite way

This is the same separation as [tradebot](https://github.com/gkhurana21/tradebot), where a Go risk engine retains final authority over an LLM's trade proposals. The lesson transfers directly: **the interesting engineering is the part that says no.**

---

## 4. Users

**P0 — the small/mid merchant ("Priya", 300–3,000 SKUs).** Reprices monthly in a spreadsheet, has been burned by a markdown that went too deep. Needs: a proposal she can review, guardrails she sets herself, and an undo button she trusts.

**P1 — the ops/merchandising lead.** Manages seasonal markdowns across categories. Needs bulk review, per-collection policy, and an audit trail of who changed what and why.

**User stories**
- As a merchant, I set a margin floor and a maximum 15% change per cycle, and I am *structurally* unable to receive a proposal that breaks either.
- As a merchant, I see why each price was proposed — which signals moved it — before I approve anything.
- As a merchant, I can roll back an entire repricing run to exact prior prices in one click.
- As an ops lead, I can see every run, its policy version, and every rejected proposal with its reason.

---

## 5. Goals and non-goals

### Success criteria (portfolio-honest)
| Metric | Target | Why |
|---|---|---|
| Enforcer invariant tests | 100% pass, property-based | The safety claim must be provable, not asserted |
| Elasticity recovery on synthetic data | within ±15% of ground-truth β | Proves the estimator works when truth is known |
| Rollback fidelity | byte-exact prior prices, 100% of runs | Trust requires perfect reversibility |
| Apply latency | 500 variants < 30 s | Real catalogs, real API chunking |
| Policy decisions explained | 100% carry a rule-named reason | No unexplained changes, ever |

### Non-goals
- **No autonomous application.** Nothing reaches the catalog without explicit merchant approval in v1.
- **No competitor scraping.** Legally fraught and not the interesting problem. Competitor price is an *optional merchant-supplied input*.
- **No claim of revenue lift.** Impossible to prove without a live A/B on a real store; saying otherwise would be dishonest.
- **No cross-merchant model.** No pooling of merchant data.

---

## 6. Scope

### Phase 1 — the enforcer (week 1) · **BUILT**
The policy engine, standalone and fully tested, before any model exists.

- Policy schema: margin floor (absolute or %), MAP price, max Δ% per cycle, min days between changes per SKU, collection/tag exclusions, rounding rules (.99, .95, whole)
- `decide(proposal, policy, sku_state) → {action: approve|clamp|reject, final_price, reason, rule_id}`
- Property-based tests and Go's native fuzzer asserting the invariants in §3
- Golden-file tests for every rule and every interaction between rules

**Exit:** the enforcer cannot be made to violate an invariant by any generated input.
**Result:** 74.4M fuzz executions in 10 minutes, 0 violations (first measured as 4.5M in 40 seconds). 49 discovered corpus entries committed as regression cases. Two defects found by the tests: clamps naming the wrong binding rule, and a summary breakdown that undercounted. Two more found in review in November 2026, each now a test: a proposed cut could be clamped and rounded into a rise, and the velocity rule depended on the server's time zone.

### Phase 2 — demand signal + proposer (weeks 2–3) · **BUILT**
- **Elasticity estimation** per product/collection from order history: log-log regression of quantity on price with controls, shrunk toward the collection mean when a SKU has thin data (hierarchical/partial pooling — the honest fix for sparse SKUs)
- Confidence interval per estimate; **low-confidence SKUs propose no change** rather than a noisy one
- Inventory-age and sell-through signals for markdown candidates
- Proposal = the margin-optimal price under the estimated demand curve, then handed to the enforcer

**Exit:** on synthetic data with known ground-truth elasticity, the estimator recovers β within ±15% and its confidence intervals are calibrated.
**Result:** 2.0%–6.7% error across four known elasticities; 94.8% coverage on a stated 95% interval over 600 trials; 56% MSE reduction from pooling across 40 sparse SKUs. Two defects found: a zero-variance control column made X'X singular for every SKU that never went on promo, and catalog-wide pooling degraded well-identified SKUs until it was scoped to collections. A third, found in review in November 2026: the estimator is biased at low sales volume and its intervals do not show it, so it now refuses below 45 units a day per SKU, a floor set by a 330,000-trial sweep (`cmd/sweep`).

### Phase 3 — merchant app (weeks 4–5)
Extends the existing BulkPilot codebase.

- Policy editor (Polaris) — the merchant sets their own rules
- Run review screen: proposal table with current → proposed, Δ%, margin after, the signals behind it, and the enforcer's decision
- Approve all / approve selected / reject
- Apply via `productVariantsBulkUpdate`, chunked to 250, with per-variant partial-failure handling
- Snapshot + one-click rollback (already built in BulkPilot)
- Run history with policy version pinned per run

**Exit:** a full cycle on a Shopify dev store — propose, review, apply, roll back — with prices restored exactly.

### Phase 4 — explanation and governance (week 6)
- Per-proposal explanation: which signals moved the price and by how much
- Audit log: every run, policy hash, proposals, decisions, applied results
- Model card documenting data limitations honestly (see §7)

---

## 7. The data problem — stated up front

**A portfolio project has no merchant sales data, and elasticity cannot be estimated without it.** Pretending otherwise would be the project's biggest integrity failure. Three sources, each labelled in the UI:

1. **Synthetic generator (primary for validation).** Simulate orders from a known demand curve with configurable elasticity, seasonality, promo periods, and noise. Because ground truth is known, the estimator can be *proven* to recover it — something real data can never demonstrate.
2. **Public retail transaction data (secondary).** For realistic messiness — sparse SKUs, irregular price changes, missing categories.
3. **Shopify dev store (integration path).** Seeded products and orders to exercise the real API, OAuth, chunking, and rollback end to end.

**In-product honesty requirement:** every proposal shows its data basis and confidence. A SKU with 4 orders shows *"insufficient data — no change proposed"*, not a confident number. Elasticity estimates from synthetic data are labelled as such. **No percentage is displayed that the data cannot support.**

---

## 8. Tech stack

| Layer | Choice | Status | Rationale |
|---|---|---|---|
| Enforcer | Go, pure functions, integer money, native fuzzing | Built | No I/O, so its guarantees can be tested on every input |
| Estimation | Go, standard library only (own OLS and t-quantiles) | Built | One language and no dependencies between the model and the guardrail |
| CI | GitHub Actions: gofmt, vet, race tests, a short fuzz run | Built | The committed fuzz corpus runs as regression cases on every push |
| Shopify app | React Router 7, Polaris, App Bridge, Prisma | Phase 3, not built | Already proven in BulkPilot; the official embedded stack |
| App to engine | To be settled in the phase 3 plan | Phase 3, not built | The app must run the same Go source that was fuzzed, not a port |
| Data | Prisma (SQLite in BulkPilot today) | Phase 3, not built | Runs, snapshots, policies, audit log |

v1.0 of this document planned a TypeScript enforcer and a Python estimation service. Both were built in Go instead.

---

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Elasticity estimates are too noisy to be useful on sparse SKUs | **High** | Partial pooling toward collection mean; propose nothing below a confidence threshold. A tool that declines to guess is more credible than one that always answers. |
| Reviewers read "AI changes your prices" and stop there | Medium | Lead every surface with the enforcer, not the model. The demo opens by *showing a proposal get rejected*. |
| Scope creep into a full pricing suite | High | Phase 1 is the enforcer alone. If only phases 1–2 ship, the project still demonstrates the thesis. |
| Synthetic data seen as a cop-out | Medium | Frame it correctly: synthetic data is the *only* way to prove estimator correctness, and it's paired with a real dev-store integration. |
| Shopify API limits on large catalogs | Low | Already solved in BulkPilot — 250-variant chunking, partial-failure handling. |

---

## 10. Decisions (locked)

1. **The enforcer ships first, before any model.** The safety story is the product; building it last would make it decoration.
2. **The enforcer is pure and deterministic** — no model call, no network, no randomness — so its guarantees are testable rather than hoped for.
3. **Nothing auto-applies in v1.** Merchant approval is required for every run.
4. **Build on BulkPilot rather than starting fresh.** OAuth, session storage, bulk mutations, and rollback are solved; rewriting them proves nothing.
5. **No competitor scraping.** Optional merchant-supplied input only.
6. **Low-confidence SKUs propose no change.** Silence beats a confident wrong number.
7. **Synthetic data is the validation set of record**, because ground-truth elasticity is knowable there and nowhere else.
8. **No revenue-lift claims** without a live merchant A/B. The README will say so explicitly.
9. **Every rejection names the rule it failed.** No unexplained decisions.

---

## 11. What this demonstrates to Shopify

- **Commerce domain understanding** — margin floors, MAP, markdown cadence, and rounding psychology are merchant realities, not invented features
- **The official embedded stack**, used properly: Polaris, App Bridge, GraphQL Admin API, chunked bulk mutations, partial-failure handling
- **Engineering judgment under uncertainty** — partial pooling for sparse SKUs, declining to answer when data is thin, separating the probabilistic part from the part that must never be wrong
- **Merchant empathy as architecture** — the guardrails, preview, and rollback exist because a merchant's trust is the actual constraint
- **Honest evaluation** — synthetic ground truth for what can be proven, explicit limitations for what cannot

---

## 12. Parking lot

Not scheduled; nothing here gets built without evidence.

- Autonomous mode with a merchant-set risk budget
- Bundle and cross-elasticity effects (cannibalization)
- Promotion calendar awareness
- Multi-currency / market-specific pricing
- A/B harness for measuring actual lift on a live store
