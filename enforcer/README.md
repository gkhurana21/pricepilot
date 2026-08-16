# PricePilot Enforcer

**The half of an AI repricing agent that must never be wrong.**

A model proposes price changes. This package decides whether any of them may reach a merchant's catalog. It is deliberately the least clever component in the system and the only one whose behaviour is guaranteed.

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

Merchants are right to be afraid of an agent that changes prices. The interesting engineering is not the part that suggests a number — it is the part that refuses one, and can prove it refuses correctly.

---

## Why this is provable

The engine is pure. No network, no database, no system clock, no randomness, no model call. `now` is an argument. Every input arrives as a parameter and the same inputs always produce the same `Decision`.

That purity is what turns the safety story from a claim into a property a fuzzer can attack:

1. An approved price is never below an active margin floor.
2. An approved price is never below MAP when MAP is respected.
3. An approved price never moves further than the per-cycle caps allow.
4. An excluded SKU is never assigned a price.
5. `FinalPrice` is non-zero if and only if the action is not `reject`.
6. Every non-approval names the rule responsible.

All six live in one function, [`checkInvariants`](invariants_test.go). The table tests, the randomized property test, and both fuzzers funnel through it, so a guarantee is stated once and no test can quietly assert a weaker version of it.

```
go test -run '^$' -fuzz=FuzzDecide -fuzztime=40s
fuzz: elapsed: 40s, execs: 4535636 (109884/sec), new interesting: 63 (total: 231)
PASS
```

4.5M executions, zero invariant violations. 49 corpus entries discovered by the fuzzer are committed under `testdata/`, so they run as regression cases on every plain `go test` — no one has to remember to launch the fuzzer.

## Design decisions worth defending

**It fails closed.** A margin floor with no unit cost *rejects*; it does not skip the floor. Silently skipping is the exact failure this package exists to prevent — a merchant who believes they are protected and is not is worse off than one with no guardrail at all.

**Money is never a float.** All amounts are `Cents` (int64), all rates are `BasisPoints` (10000 = 100%). Integer division always rounds in the tightening direction — lower bounds round up, upper bounds round down — so no bound is ever relaxed by a cent through arithmetic.

**Rounding is a constrained search, not a post-hoc transform.** This is the subtlest rule here. Applied naively last, `.99` rounding takes a $10.02 price sitting on a $10.00 margin floor and ships $9.99 — undoing every check that came before it. `roundWithin` may only select values the bounds already permit, and stands down entirely when no permitted ending exists, because a correct price beats a pretty one.

**Contradictory guardrails are reported, not resolved.** When a margin floor demands $208.34 and a 10% per-cycle cap allows only $196.90, the engine refuses and says so — then adds *"$208.34 is reachable in 2 cycles at the current 10.00% cap"*, so a dead end comes with a way out.

**A clamp names the rule that actually bound it.** An early version attributed every upward clamp to the margin floor; a table test caught it doing that when `max_decrease` was the real constraint. Telling a merchant the wrong rule sends them to edit the wrong setting, which is its own kind of wrong answer.

**Any figure a merchant can add up must add up.** The demo once printed "8 held back" above a breakdown summing to 6 — the engine was right and the display walked a hardcoded list of rule ids that had drifted. The breakdown is now derived from the summary itself, and `TestSummaryReconciles` asserts the two counts agree. Numbers a reader can check are the ones that earn trust in the numbers they cannot.

**A one-cent change is not a change.** `MinChangeBP` rejects moves too small to matter. Without it, a rounding rule manufactures a $12.00 → $11.99 markdown on a SKU the estimator explicitly said to leave alone, spending an API call and a velocity slot for nothing.

**The change budget is decided across the run, not per SKU.** A merchant capping "never move more than half my catalog at once" is guarding against a systemic estimator failure. Survivors are chosen highest-confidence-first with ties broken by SKU id, so re-running a review never shuffles the set.

## Test surface

| Suite | What it establishes |
|---|---|
| `TestDecide` | 15 golden cases, one per rule, each asserting the exact resulting price |
| `TestInvariantsUnderRandomInput` | 200k seeded scenarios; guards against the sample going hollow by requiring both approvals and rejections |
| `TestDecisionIsAFixedPoint` | Re-deciding a settled price proposes nothing further — a scheduled repricer cannot oscillate |
| `TestRaisingTheMarginFloorNeverLowersThePrice` | A stricter policy never produces a worse outcome |
| `TestMarginFloorArithmetic` | 40% gross margin on $10.00 cost is $16.67; the same numbers as *markup* are $14.00 |
| `TestSummaryReconciles` | Every figure a merchant can add up themselves does add up, across 2k random batches |
| `FuzzDecide` | All six invariants plus determinism, under arbitrary input |
| `FuzzRoundWithin` | Rounding lands on the pattern, inside the interval, and at the nearest permitted value |

The scenario generator runs in two modes on purpose. A purely hostile generator rejected 99.9% of inputs — every invariant passed while the margin, MAP, and cap rules were barely reached, because those only matter on the approve and clamp paths. It now produces coherent merchant configurations 75% of the time, and 41% of scenarios reach a real price.

## Run it

```bash
go test ./...                                      # suite + committed fuzz corpus
go test -run '^$' -fuzz=FuzzDecide -fuzztime=60s   # deep search
go run ./cmd/demo                                  # a merchant's review screen
```

The demo opens with the changes that were *refused*, because that is the part worth trusting:

```
  HELD BACK — the agent proposed these and the policy refused

    Chemex Classic 6-cup            52.00  →  no change
      → proposed 42.00 raised to 51.67 by the binding lower bound
      → rounded 51.67 to 51.99 within the admissible range
      · 52.00 to 51.99 is a -0.02% move, below the 2.00% worth applying
    Baratza Encore Grinder         179.00  →  no change
      × policy leaves no admissible price: margin_floor sets a floor of 208.34
        but max_increase sets a ceiling of 196.90; 208.34 is reachable in
        2 cycles at the current 10.00% cap
    Monthly Roaster's Pick          24.00  →  no change
      × SKU is excluded by tag "subscription"
    Kenya Nyeri AA 250g             26.00  →  no change
      × last repriced 2026-08-11; policy requires 14 days between changes
    Cold Brew Concentrate           15.00  →  no change
      × confidence 42.00% is below the 60.00% minimum; no change proposed
```

## Scope

This package decides. It does not estimate demand, call the Shopify API, or store anything — those live in the wider [PricePilot](../PRD.md) project, which extends an existing embedded Shopify app for OAuth, `productVariantsBulkUpdate` chunking, and snapshot rollback.

**Elasticity estimation is not solved here and is not claimed to be.** Estimating it needs real order history, which a portfolio project does not have. The PRD's answer is synthetic order generation from a known demand curve — the only setting where an estimator can be *proven* to recover ground truth — paired with a dev-store integration for the real API path. No revenue-lift number appears anywhere in this project, because proving lift requires a live A/B on a real store.
