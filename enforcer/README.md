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
7. A price that changes moves the way the proposal pointed: a proposed cut never becomes a rise, and a proposed rise never becomes a cut.

All seven live in one function, [`checkInvariants`](invariants_test.go). The table tests, the randomized property test, and both fuzzers funnel through it, so a guarantee is stated once and no test can quietly assert a weaker version of it.

```
go test -run '^$' -fuzz=FuzzDecide -fuzztime=10m
fuzz: elapsed: 10m0s, execs: 74413440 (111164/sec), new interesting: 5 (total: 299)
PASS
```

74.4M executions in ten minutes on an Apple M3 (Go 1.26.5, 8 workers), zero invariant violations, run on 2026-11-17 (UTC) against the seven-invariant code. An execution count mostly measures time spent: the same machine does about 4.5M in 40 seconds, and new coverage is rare after the first few seconds. The stronger evidence is what is checked on every input and the 49 corpus entries the fuzzer discovered, which are committed under `testdata/` and run as regression cases on every plain `go test` — no one has to remember to launch the fuzzer.

## Design decisions worth defending

**It fails closed.** A margin floor with no unit cost *rejects*; it does not skip the floor. Silently skipping is the exact failure this package exists to prevent — a merchant who believes they are protected and is not is worse off than one with no guardrail at all.

**Money is never a float.** All amounts are `Cents` (int64), all rates are `BasisPoints` (10000 = 100%). Integer division always rounds in the tightening direction — lower bounds round up, upper bounds round down — so no bound is ever relaxed by a cent through arithmetic.

**Rounding is a constrained search, not a post-hoc transform.** This is the subtlest rule here. Applied naively last, `.99` rounding takes a $10.02 price sitting on a $10.00 margin floor and ships $9.99 — undoing every check that came before it. `roundWithin` may only select values the bounds already permit, and stands down entirely when no permitted ending exists, because a correct price beats a pretty one.

**The proposal's direction is a bound.** The seventh invariant was added after reading this package's own demo. The model proposed cutting a $18.00 bag to $14.00; the margin floor sat at exactly $18.00, so the clamp held the price, and then `.99` rounding moved it up to $18.99. A proposed 22% cut was shown to the merchant as a 5.5% rise labelled "adjusted", and nothing forbade it: about 0.5% of priced decisions in the random suite reversed this way. A cut now caps the admissible range at the current price and a rise floors it there, before rounding runs, so rounding can only search the side the model asked for. When the current price is already below a floor and the model asks to cut, the engine refuses and says the price is below the floor; it does not raise a price nobody proposed raising.

**The velocity rule counts days in UTC.** `AddDate` works on the wall clock, and a timestamp decoded from JSON picks up the server's zone, so a 14-day cooldown that spanned a daylight-saving change decided differently on a laptop in Toronto and a server in UTC. The fuzzer could not see it because its clock was always UTC. The test now sets the local zone to one with daylight saving and requires the same decisions as UTC.

**Contradictory guardrails are reported, not resolved.** When a proposed rise meets a margin floor that demands $43.34 and a 10% per-cycle cap that allows only $35.20, the engine refuses and says so — then adds *"43.34 is reachable in 4 cycles at the current 10.00% cap"*, so a dead end comes with a way out.

**A clamp names the rule that actually bound it.** An early version attributed every upward clamp to the margin floor; a table test caught it doing that when `max_decrease` was the real constraint. Telling a merchant the wrong rule sends them to edit the wrong setting, which is its own kind of wrong answer.

**Any figure a merchant can add up must add up.** The demo once printed "8 held back" above a breakdown summing to 6 — the engine was right and the display walked a hardcoded list of rule ids that had drifted. The breakdown is now derived from the summary itself, and `TestSummaryReconciles` asserts the two counts agree. Numbers a reader can check are the ones that earn trust in the numbers they cannot.

**A one-cent change is not a change.** `MinChangeBP` rejects moves too small to matter: a $52.00 → $51.99 markdown spends an API call and a velocity slot for nothing. A proposal equal to the current price is refused earlier still, as `no_change`, so a rounding rule cannot manufacture a $12.00 → $11.99 markdown on a SKU the estimator said to leave alone.

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
| `TestProposalDirectionIsABound` | A cut is never rounded or clamped into a rise; a cut on a SKU already below its floor is refused with the floor named |
| `TestVelocityDoesNotDependOnTheServerTimeZone` | Cooldowns across a daylight-saving change decide the same in Toronto as in UTC |
| `FuzzDecide` | All seven invariants plus determinism, under arbitrary input |
| `FuzzRoundWithin` | Rounding lands on the pattern, inside the interval, and at the nearest permitted value |

The fuzzers and the invariants cover `Decide`, one SKU at a time. `DecideBatch` and its change budget are covered by table tests and `TestSummaryReconciles`, not by the fuzzer.

The scenario generator runs in three modes on purpose. A purely hostile generator rejected 99.9% of inputs — every invariant passed while the margin, MAP, and cap rules were barely reached, because those only matter on the approve and clamp paths. It now produces hostile input a quarter of the time, coherent merchant configurations about 69% of the time, and for one scenario in sixteen a SKU whose current price is already below its floor, which is where the direction rule earns its place. 37% of scenarios reach a real price.

## Run it

```bash
go test ./...                                      # suite + committed fuzz corpus
go test -run '^$' -fuzz=FuzzDecide -fuzztime=60s   # deep search
go run ./cmd/demo                                  # a merchant's review screen
```

The demo opens with the changes that were *refused*, because that is the part worth trusting:

<!-- golden: demo -->
```
  HELD BACK — the agent proposed these and the policy refused

    Colombia Huila 250g             18.00  →  no change 
      → proposed 14.00 raised to 18.00 by the binding lower bound
      · no price ending permitted by the rounding rule fits inside the admissible range; keeping the exact price
      · compliant price equals the current price 18.00; nothing to apply
    Chemex Classic 6-cup            52.00  →  no change 
      → proposed 42.00 raised to 51.67 by the binding lower bound
      → rounded 51.67 to 51.99 within the admissible range
      · 52.00 to 51.99 is a -0.02% move, below the 2.00% worth applying
    Baratza Encore Grinder         179.00  →  no change 
      × the current price 179.00 is below the floor of 208.34 set by margin_floor, so a decrease proposal cannot be applied; raise the price to the floor or relax margin_floor
    Monthly Roaster's Pick          24.00  →  no change 
      × SKU is excluded by tag "subscription"
    Kenya Nyeri AA 250g             26.00  →  no change 
      × last repriced 2026-08-11; policy requires 14 days between changes (next eligible 2026-08-25)
    Cold Brew Concentrate           15.00  →  no change 
      × confidence 42.00% is below the 60.00% minimum; no change proposed
```

## Scope

This package decides. It does not estimate demand, call the Shopify API, or store anything — those live in the wider [PricePilot](../PRD.md) project, which extends an existing embedded Shopify app for OAuth, `productVariantsBulkUpdate` chunking, and snapshot rollback.

**Elasticity estimation is not solved here and is not claimed to be.** Estimating it needs real order history, which a portfolio project does not have. The PRD's answer is synthetic order generation from a known demand curve — the only setting where an estimator can be *proven* to recover ground truth — paired with a dev-store integration for the real API path. No revenue-lift number appears anywhere in this project, because proving lift requires a live A/B on a real store.
