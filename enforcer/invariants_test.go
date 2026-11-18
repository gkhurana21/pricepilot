package enforcer

import (
	"testing"
	"time"
)

// checkInvariants asserts the seven invariants (the six in the package doc plus direction, number 7) against a single
// decision. Every test in this package funnels through it — table tests, the
// randomized property test, and the fuzzer — so a guarantee only has to be
// stated once and no test can accidentally assert a weaker version of it.
func checkInvariants(t *testing.T, pol Policy, sku SKUState, prop Proposal, now time.Time, d Decision) {
	t.Helper()

	// (0) The verdict is one of exactly three values.
	switch d.Action {
	case ActionApprove, ActionClamp, ActionReject:
	default:
		t.Fatalf("invariant violated: unknown action %q", d.Action)
	}

	// (5) FinalPrice is non-zero iff the proposal was not rejected.
	if (d.Action == ActionReject) != (d.FinalPrice == 0) {
		t.Fatalf("invariant violated: action %q with final price %s", d.Action, d.FinalPrice)
	}

	// (6) Every non-approval names the rule responsible.
	if d.Action != ActionApprove && len(d.Reasons) == 0 {
		t.Fatalf("invariant violated: action %q carries no reason", d.Action)
	}

	// (4) An excluded SKU is never assigned a price.
	if _, _, ok := excluded(pol.Exclusions, sku); ok && d.Action != ActionReject {
		t.Fatalf("invariant violated: excluded SKU %q received action %q", sku.ID, d.Action)
	}

	// A proposal below the confidence bar never produces a change.
	if pol.MinConfidenceBP > 0 && prop.ConfidenceBP < pol.MinConfidenceBP && d.Action != ActionReject {
		t.Fatalf("invariant violated: confidence %s below minimum %s produced action %q",
			prop.ConfidenceBP, pol.MinConfidenceBP, d.Action)
	}

	if d.Action == ActionReject {
		return
	}

	// Beyond this point a price is going to the catalog. Everything below is a
	// bound that price must satisfy.

	if err := pol.Validate(); err != nil {
		t.Fatalf("invariant violated: invalid policy produced a price: %v", err)
	}
	if err := validateInputs(sku, prop); err != nil {
		t.Fatalf("invariant violated: invalid input produced a price: %v", err)
	}

	// (1) Never below an active margin floor.
	if pol.MarginFloor.active() {
		floor, err := marginFloorPrice(pol.MarginFloor, sku.UnitCost)
		if err != nil {
			t.Fatalf("invariant violated: uncomputable margin floor produced a price: %v", err)
		}
		if d.FinalPrice < floor {
			t.Fatalf("invariant violated: final %s is below margin floor %s (cost %s, basis %q, rate %s)",
				d.FinalPrice, floor, sku.UnitCost, pol.MarginFloor.Basis, pol.MarginFloor.Rate)
		}
	}

	// (2) Never below MAP when MAP is respected.
	if pol.RespectMAP && sku.MAPPrice > 0 && d.FinalPrice < sku.MAPPrice {
		t.Fatalf("invariant violated: final %s is below MAP %s", d.FinalPrice, sku.MAPPrice)
	}

	// Catalog-wide hard bounds.
	if pol.HardFloor > 0 && d.FinalPrice < pol.HardFloor {
		t.Fatalf("invariant violated: final %s is below catalog floor %s", d.FinalPrice, pol.HardFloor)
	}
	if pol.HardCeiling > 0 && d.FinalPrice > pol.HardCeiling {
		t.Fatalf("invariant violated: final %s is above catalog ceiling %s", d.FinalPrice, pol.HardCeiling)
	}

	// (3) Never further than the per-cycle caps allow.
	minAllowed := mulBPCeil(sku.CurrentPrice, OneHundredPercent-pol.MaxDecreaseBP)
	if d.FinalPrice < minAllowed {
		t.Fatalf("invariant violated: final %s cuts past the %s decrease cap (floor %s from current %s)",
			d.FinalPrice, pol.MaxDecreaseBP, minAllowed, sku.CurrentPrice)
	}
	maxAllowed := mulBP(sku.CurrentPrice, OneHundredPercent+pol.MaxIncreaseBP)
	if d.FinalPrice > maxAllowed {
		t.Fatalf("invariant violated: final %s exceeds the %s increase cap (ceiling %s from current %s)",
			d.FinalPrice, pol.MaxIncreaseBP, maxAllowed, sku.CurrentPrice)
	}

	// Velocity gates are absolute: a SKU repriced too recently gets no price.
	if v := pol.Velocity; v.MinDaysBetweenChanges > 0 && !sku.LastPriceChangeAt.IsZero() {
		// UTC, as in Decide: day arithmetic must not depend on the server's zone.
		if now.UTC().Before(sku.LastPriceChangeAt.UTC().AddDate(0, 0, v.MinDaysBetweenChanges)) {
			t.Fatalf("invariant violated: SKU repriced inside the %d-day cooldown", v.MinDaysBetweenChanges)
		}
	}
	if v := pol.Velocity; v.MaxChangesPerWindow > 0 && sku.ChangesInWindow >= v.MaxChangesPerWindow {
		t.Fatalf("invariant violated: SKU repriced past its %d-change window limit", v.MaxChangesPerWindow)
	}

	// A change that changes nothing is not a change.
	if d.FinalPrice == sku.CurrentPrice {
		t.Fatalf("invariant violated: action %q produced a no-op at %s", d.Action, d.FinalPrice)
	}

	// (7) The final price lies between the current price and the proposal: on
	// the proposal's side of the current price, and never past the proposal. A
	// guardrail may hold a change back; nothing in the engine may make it
	// larger than the model asked for, or point it the other way. A proposal
	// equal to the current price has no room at all and must never produce a
	// price.
	if sign(d.FinalPrice-sku.CurrentPrice) != sign(prop.ProposedPrice-sku.CurrentPrice) {
		t.Fatalf("invariant violated: proposed %s from current %s but final is %s (opposite direction)",
			prop.ProposedPrice, sku.CurrentPrice, d.FinalPrice)
	}
	if (prop.ProposedPrice < sku.CurrentPrice && d.FinalPrice < prop.ProposedPrice) ||
		(prop.ProposedPrice > sku.CurrentPrice && d.FinalPrice > prop.ProposedPrice) {
		t.Fatalf("invariant violated: proposed %s from current %s but final is %s (past the proposal)",
			prop.ProposedPrice, sku.CurrentPrice, d.FinalPrice)
	}

	// Nor is a change too small to be worth applying.
	if pol.MinChangeBP > 0 && absBP(deltaBP(sku.CurrentPrice, d.FinalPrice)) < pol.MinChangeBP {
		t.Fatalf("invariant violated: %s to %s is below the %s minimum change",
			sku.CurrentPrice, d.FinalPrice, pol.MinChangeBP)
	}

	// The reported interval must actually contain the price it produced.
	if d.FinalPrice < d.LowerBound || d.FinalPrice > d.UpperBound {
		t.Fatalf("invariant violated: final %s is outside the reported range [%s, %s]",
			d.FinalPrice, d.LowerBound, d.UpperBound)
	}

	// An approval means nothing was moved; a clamp means something was.
	if d.Action == ActionApprove && d.FinalPrice != prop.ProposedPrice {
		t.Fatalf("invariant violated: approved price %s differs from proposal %s without a clamp",
			d.FinalPrice, prop.ProposedPrice)
	}
}

func sign(c Cents) int {
	switch {
	case c > 0:
		return 1
	case c < 0:
		return -1
	}
	return 0
}
