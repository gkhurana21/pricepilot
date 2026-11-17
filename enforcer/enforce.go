// Package enforcer decides whether a proposed price change may reach a
// merchant's catalog.
//
// It is the half of PricePilot that must never be wrong. A model proposes; this
// package holds final authority. To keep that authority verifiable it is pure:
// no network, no clock, no database, no randomness, no model. Every input
// arrives as an argument and the same inputs always yield the same Decision, so
// the guarantees below are properties the fuzzer can attack rather than claims
// in a README:
//
//  1. An approved price is never below an active margin floor.
//  2. An approved price is never below MAP when MAP is respected.
//  3. An approved price never moves further than the per-cycle caps allow.
//  4. An excluded SKU is never assigned a price.
//  5. FinalPrice is non-zero if and only if the action is not reject.
//  6. Every non-approval names the rule responsible.
//  7. An approved price moves in the direction that was proposed: a proposed cut
//     never becomes a rise, a proposed rise never becomes a cut.
//
// Where a rule cannot be evaluated, the engine fails closed: a margin floor
// with no unit cost rejects rather than silently skipping the floor. Silently
// skipping is the exact failure this package exists to prevent.
package enforcer

import (
	"fmt"
	"time"
)

// Decide evaluates one proposal against one policy. now is injected rather than
// read from the system clock so velocity rules are reproducible in tests and
// replayable from an audit log.
func Decide(pol Policy, sku SKUState, prop Proposal, now time.Time) Decision {
	d := Decision{
		SKUID:         sku.ID,
		CurrentPrice:  sku.CurrentPrice,
		ProposedPrice: prop.ProposedPrice,
		Signals:       prop.Signals,
	}

	// ---- Gate rules: block the SKU outright, no price is produced. ----------

	if err := pol.Validate(); err != nil {
		return reject(&d, RuleInvalidInput, EffectBlocked,
			"policy is not valid: "+err.Error())
	}
	if err := validateInputs(sku, prop); err != nil {
		return reject(&d, RuleInvalidInput, EffectBlocked, err.Error())
	}

	if rule, match, ok := excluded(pol.Exclusions, sku); ok {
		return reject(&d, RuleExcluded, EffectBlocked,
			fmt.Sprintf("SKU is excluded by %s %q", rule, match))
	}

	if pol.MinConfidenceBP > 0 && prop.ConfidenceBP < pol.MinConfidenceBP {
		return reject(&d, RuleConfidence, EffectBlocked,
			fmt.Sprintf("confidence %s is below the %s minimum; no change proposed",
				prop.ConfidenceBP, pol.MinConfidenceBP))
	}

	// Day arithmetic is done in UTC. AddDate on a time in a zone with daylight
	// saving moves the wall clock, so "14 days" would be 14*24h plus or minus an
	// hour depending on the server's zone and the date. A timestamp decoded
	// from JSON carries time.Local when its offset matches the server's, which
	// is exactly how the same instant could decide differently on two machines.
	if v := pol.Velocity; v.MinDaysBetweenChanges > 0 && !sku.LastPriceChangeAt.IsZero() {
		last := sku.LastPriceChangeAt.UTC()
		earliest := last.AddDate(0, 0, v.MinDaysBetweenChanges)
		if now.UTC().Before(earliest) {
			return reject(&d, RuleVelocityDays, EffectBlocked,
				fmt.Sprintf("last repriced %s; policy requires %d days between changes (next eligible %s)",
					last.Format(time.DateOnly), v.MinDaysBetweenChanges,
					earliest.Format(time.DateOnly)))
		}
	}

	if v := pol.Velocity; v.MaxChangesPerWindow > 0 && sku.ChangesInWindow >= v.MaxChangesPerWindow {
		return reject(&d, RuleVelocityCount, EffectBlocked,
			fmt.Sprintf("already repriced %d times in the last %d days; policy allows %d",
				sku.ChangesInWindow, v.WindowDays, v.MaxChangesPerWindow))
	}

	// ---- Bound rules: narrow the admissible interval [lo, hi]. -------------
	//
	// Integer division always rounds in the tightening direction — lower bounds
	// round up, upper bounds round down — so a bound is never relaxed by a cent
	// through arithmetic.

	lo, hi := Cents(1), MaxPrice
	// loRule / hiRule remember which guardrail is actually binding, so a clamp
	// can name the rule the merchant would need to edit. Attributing a clamp to
	// the wrong rule is its own kind of wrong answer.
	loRule, hiRule := RuleHardFloor, RuleHardCeiling

	if pol.MarginFloor.active() {
		floor, err := marginFloorPrice(pol.MarginFloor, sku.UnitCost)
		if err != nil {
			return reject(&d, RuleInvalidInput, EffectBlocked, err.Error())
		}
		if floor > lo {
			lo, loRule = floor, RuleMarginFloor
			d.add(RuleMarginFloor, EffectBound,
				fmt.Sprintf("margin floor holds price at or above %s", floor))
		}
	}

	if pol.RespectMAP && sku.MAPPrice > 0 && sku.MAPPrice > lo {
		lo, loRule = sku.MAPPrice, RuleMAP
		d.add(RuleMAP, EffectBound,
			fmt.Sprintf("MAP holds price at or above %s", sku.MAPPrice))
	}

	if pol.HardFloor > 0 && pol.HardFloor > lo {
		lo, loRule = pol.HardFloor, RuleHardFloor
		d.add(RuleHardFloor, EffectBound,
			fmt.Sprintf("catalog floor holds price at or above %s", pol.HardFloor))
	}

	// A zero cap means that direction is closed, not unlimited.
	minByChange := mulBPCeil(sku.CurrentPrice, OneHundredPercent-pol.MaxDecreaseBP)
	if minByChange > lo {
		lo, loRule = minByChange, RuleMaxDecrease
		d.add(RuleMaxDecrease, EffectBound,
			fmt.Sprintf("per-cycle decrease cap of %s holds price at or above %s",
				pol.MaxDecreaseBP, minByChange))
	}

	if pol.HardCeiling > 0 && pol.HardCeiling < hi {
		hi, hiRule = pol.HardCeiling, RuleHardCeiling
		d.add(RuleHardCeiling, EffectBound,
			fmt.Sprintf("catalog ceiling holds price at or below %s", pol.HardCeiling))
	}

	maxByChange := mulBP(sku.CurrentPrice, OneHundredPercent+pol.MaxIncreaseBP)
	if maxByChange < hi {
		hi, hiRule = maxByChange, RuleMaxIncrease
		d.add(RuleMaxIncrease, EffectBound,
			fmt.Sprintf("per-cycle increase cap of %s holds price at or below %s",
				pol.MaxIncreaseBP, maxByChange))
	}

	// The direction of the proposal is itself a bound: a proposed cut may land
	// anywhere at or below the current price, a proposed rise anywhere at or
	// above it, and a proposal equal to the current price only on it. Applied
	// after every other bound and before rounding, so rounding searches only
	// the permitted side and stands down when no permitted ending fits.
	dir := directionWord(prop.ProposedPrice, sku.CurrentPrice)
	if prop.ProposedPrice <= sku.CurrentPrice && sku.CurrentPrice < hi {
		hi, hiRule = sku.CurrentPrice, RuleProposalDirection
		d.add(RuleProposalDirection, EffectBound,
			fmt.Sprintf("a %s proposal holds price at or below the current %s", dir, sku.CurrentPrice))
	}
	if prop.ProposedPrice >= sku.CurrentPrice && sku.CurrentPrice > lo {
		lo, loRule = sku.CurrentPrice, RuleProposalDirection
		d.add(RuleProposalDirection, EffectBound,
			fmt.Sprintf("a %s proposal holds price at or above the current %s", dir, sku.CurrentPrice))
	}

	d.LowerBound, d.UpperBound = lo, hi

	// Contradictory guardrails are the merchant's to resolve, not the engine's
	// to quietly pick a winner from. Name both sides and refuse.
	if lo > hi {
		var msg string
		switch {
		case hiRule == RuleProposalDirection:
			// The price is already outside a rule the proposal cannot fix: the
			// engine will not push it back up while the model asked to cut it.
			msg = fmt.Sprintf("the current price %s is below the floor of %s set by %s, so a %s proposal cannot be applied; "+
				"raise the price to the floor or relax %s",
				sku.CurrentPrice, lo, loRule, directionWord(prop.ProposedPrice, sku.CurrentPrice), loRule)
		case loRule == RuleProposalDirection:
			msg = fmt.Sprintf("the current price %s is above the ceiling of %s set by %s, so a %s proposal cannot be applied; "+
				"lower the price to the ceiling or relax %s",
				sku.CurrentPrice, hi, hiRule, directionWord(prop.ProposedPrice, sku.CurrentPrice), hiRule)
		default:
			msg = fmt.Sprintf("policy leaves no admissible price: %s sets a floor of %s but %s sets a ceiling of %s",
				loRule, lo, hiRule, hi)
			// A dead end is more useful with a way out of it. When the ceiling is
			// the per-cycle cap, the floor is usually reachable over several runs.
			if hiRule == RuleMaxIncrease {
				if n, ok := cyclesToReach(sku.CurrentPrice, lo, pol.MaxIncreaseBP); ok {
					msg += fmt.Sprintf("; %s is reachable in %d cycles at the current %s cap",
						lo, n, pol.MaxIncreaseBP)
				}
			}
		}
		return reject(&d, RuleInfeasible, EffectBlocked, msg)
	}

	// ---- Clamp, then round inside the interval. ----------------------------

	final := prop.ProposedPrice
	clamped := false
	if final < lo {
		final, clamped = lo, true
		d.add(loRule, EffectClamped,
			fmt.Sprintf("proposed %s raised to %s by the binding lower bound", prop.ProposedPrice, lo))
	} else if final > hi {
		final, clamped = hi, true
		d.add(hiRule, EffectClamped,
			fmt.Sprintf("proposed %s lowered to %s by the binding upper bound", prop.ProposedPrice, hi))
	}

	if pol.Rounding.Enabled {
		rounded, ok := roundWithin(final, lo, hi, pol.Rounding)
		switch {
		case ok && rounded != final:
			d.add(RuleRounding, EffectClamped,
				fmt.Sprintf("rounded %s to %s within the admissible range", final, rounded))
			final, clamped = rounded, true
		case !ok:
			d.add(RuleRounding, EffectInfo,
				"no price ending permitted by the rounding rule fits inside the admissible range; keeping the exact price")
		}
	}

	// A no-op still costs an API call and, worse, consumes a velocity slot that
	// a real change will need later in the cycle.
	if final == sku.CurrentPrice {
		return reject(&d, RuleNoChange, EffectInfo,
			fmt.Sprintf("compliant price equals the current price %s; nothing to apply", final))
	}

	// A change too small to matter is a no-op wearing a different hat.
	move := deltaBP(sku.CurrentPrice, final)
	if pol.MinChangeBP > 0 && absBP(move) < pol.MinChangeBP {
		return reject(&d, RuleMinChange, EffectInfo, fmt.Sprintf(
			"%s to %s is a %s move, below the %s worth applying",
			sku.CurrentPrice, final, move, pol.MinChangeBP))
	}

	d.FinalPrice = final
	d.DeltaBP = move
	d.MarginBP = grossMarginBP(final, sku.UnitCost)
	if clamped {
		d.Action = ActionClamp
	} else {
		d.Action = ActionApprove
	}
	return d
}

// directionWord names the proposal's direction for a message.
func directionWord(proposed, current Cents) string {
	switch {
	case proposed < current:
		return "decrease"
	case proposed > current:
		return "increase"
	}
	return "no-change"
}

func reject(d *Decision, rule RuleID, eff Effect, msg string) Decision {
	d.add(rule, eff, msg)
	d.Action = ActionReject
	d.FinalPrice = 0
	return *d
}

func excluded(ex Exclusions, sku SKUState) (kind, match string, ok bool) {
	for _, id := range ex.SKUIDs {
		if id == sku.ID {
			return "SKU id", id, true
		}
	}
	for _, t := range ex.Tags {
		for _, have := range sku.Tags {
			if t == have {
				return "tag", t, true
			}
		}
	}
	for _, c := range ex.Collections {
		for _, have := range sku.Collections {
			if c == have {
				return "collection", c, true
			}
		}
	}
	return "", "", false
}

// marginFloorPrice returns the lowest price satisfying the margin floor.
// It fails closed: an active rate with no unit cost is an error, never a skip.
func marginFloorPrice(m MarginFloor, cost Cents) (Cents, error) {
	floor := m.AbsoluteFloor

	if m.Rate > 0 {
		if cost <= 0 {
			return 0, fmt.Errorf(
				"margin floor of %s requires a unit cost and this variant has none; "+
					"set a cost in Shopify or exclude the SKU", m.Rate)
		}
		var byRate Cents
		switch m.Basis {
		case MarginOnCost:
			// (p - c)/c >= r  =>  p >= c * (1 + r)
			byRate = mulBPCeil(cost, OneHundredPercent+m.Rate)
		case MarginOnPrice, "":
			// (p - c)/p >= r  =>  p >= c / (1 - r)
			if m.Rate >= OneHundredPercent {
				return 0, fmt.Errorf(
					"a gross margin floor of %s is unreachable at any finite price", m.Rate)
			}
			byRate = ceilDiv(int64(cost)*int64(OneHundredPercent),
				int64(OneHundredPercent-m.Rate))
		default:
			return 0, fmt.Errorf("unknown margin basis %q", m.Basis)
		}
		if byRate > floor {
			floor = byRate
		}
	}
	return floor, nil
}

// grossMarginBP reports (price - cost) / price for display. Returns 0 when cost
// is unknown rather than implying a 100% margin.
func grossMarginBP(price, cost Cents) BasisPoints {
	if price <= 0 || cost <= 0 {
		return 0
	}
	return BasisPoints(floorDiv(int64(price-cost)*int64(OneHundredPercent), int64(price)))
}

// cyclesToReach reports how many capped increases it takes to lift price to
// target, so an infeasible decision can tell the merchant what to do instead of
// only what went wrong. Returns false when the cap makes the target unreachable.
func cyclesToReach(price, target Cents, capBP BasisPoints) (int, bool) {
	if capBP <= 0 || price <= 0 || target <= price {
		return 0, false
	}
	const maxCycles = 36
	for n := 1; n <= maxCycles; n++ {
		next := mulBP(price, OneHundredPercent+capBP)
		if next <= price {
			return 0, false // cap too small to move an integer price
		}
		price = next
		if price >= target {
			return n, true
		}
	}
	return 0, false
}
