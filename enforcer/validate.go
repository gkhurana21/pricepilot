package enforcer

import "fmt"

// MaxPrice bounds every monetary input at $1B. Real catalogs never approach it,
// and the bound keeps all internal arithmetic (price x basis points) inside
// int64 by construction rather than by luck. An engine whose guarantees depend
// on inputs being reasonable does not have guarantees.
const MaxPrice Cents = 100_000_000_000

// MaxIncreaseCapBP bounds a single cycle's raise at 1000%. Anything larger is a
// units bug in the caller, not a pricing strategy.
const MaxIncreaseCapBP BasisPoints = 100_000

// Validate reports whether a policy is internally coherent. It is checked on
// every Decide call: an invalid policy must never silently degrade into a
// permissive one, because a guardrail that fails open is worse than no
// guardrail at all — the merchant believes they are protected.
func (p Policy) Validate() error {
	if p.MaxDecreaseBP < 0 || p.MaxDecreaseBP > OneHundredPercent {
		return fmt.Errorf("max decrease must be between 0%% and 100%%, got %s", p.MaxDecreaseBP)
	}
	if p.MaxIncreaseBP < 0 || p.MaxIncreaseBP > MaxIncreaseCapBP {
		return fmt.Errorf("max increase must be between 0%% and %s, got %s", MaxIncreaseCapBP, p.MaxIncreaseBP)
	}
	if p.MinChangeBP < 0 || p.MinChangeBP > OneHundredPercent {
		return fmt.Errorf("minimum change must be between 0%% and 100%%, got %s", p.MinChangeBP)
	}
	if p.MinConfidenceBP < 0 || p.MinConfidenceBP > OneHundredPercent {
		return fmt.Errorf("minimum confidence must be between 0%% and 100%%, got %s", p.MinConfidenceBP)
	}
	if p.MaxSKUsChangedBP < 0 || p.MaxSKUsChangedBP > OneHundredPercent {
		return fmt.Errorf("change budget must be between 0%% and 100%%, got %s", p.MaxSKUsChangedBP)
	}
	if p.HardFloor < 0 || p.HardFloor > MaxPrice {
		return fmt.Errorf("catalog floor %s is outside the supported range", p.HardFloor)
	}
	if p.HardCeiling < 0 || p.HardCeiling > MaxPrice {
		return fmt.Errorf("catalog ceiling %s is outside the supported range", p.HardCeiling)
	}
	if p.HardFloor > 0 && p.HardCeiling > 0 && p.HardFloor > p.HardCeiling {
		return fmt.Errorf("catalog floor %s is above catalog ceiling %s", p.HardFloor, p.HardCeiling)
	}

	m := p.MarginFloor
	if m.Rate < 0 {
		return fmt.Errorf("margin floor rate cannot be negative, got %s", m.Rate)
	}
	if m.AbsoluteFloor < 0 || m.AbsoluteFloor > MaxPrice {
		return fmt.Errorf("absolute margin floor %s is outside the supported range", m.AbsoluteFloor)
	}
	switch m.Basis {
	case MarginOnPrice, "":
		if m.Rate >= OneHundredPercent {
			return fmt.Errorf("a gross margin floor of %s is unreachable at any finite price", m.Rate)
		}
	case MarginOnCost:
		if m.Rate > MaxIncreaseCapBP {
			return fmt.Errorf("markup floor %s exceeds the supported maximum %s", m.Rate, MaxIncreaseCapBP)
		}
	default:
		return fmt.Errorf("unknown margin basis %q", m.Basis)
	}

	if r := p.Rounding; r.Enabled {
		if r.Modulus <= 0 {
			return fmt.Errorf("rounding modulus must be positive, got %d", r.Modulus)
		}
		if r.Modulus > MaxPrice {
			return fmt.Errorf("rounding modulus %d is outside the supported range", r.Modulus)
		}
		if r.Residue < 0 || r.Residue >= r.Modulus {
			return fmt.Errorf("rounding residue %d must be in [0, %d)", r.Residue, r.Modulus)
		}
	}

	v := p.Velocity
	if v.MinDaysBetweenChanges < 0 {
		return fmt.Errorf("minimum days between changes cannot be negative, got %d", v.MinDaysBetweenChanges)
	}
	if v.MaxChangesPerWindow < 0 {
		return fmt.Errorf("maximum changes per window cannot be negative, got %d", v.MaxChangesPerWindow)
	}
	if v.MaxChangesPerWindow > 0 && v.WindowDays <= 0 {
		return fmt.Errorf("a change limit of %d needs a positive window length", v.MaxChangesPerWindow)
	}
	return nil
}

// validate reports whether the SKU and proposal are within supported ranges.
func validateInputs(sku SKUState, prop Proposal) error {
	if sku.CurrentPrice <= 0 || sku.CurrentPrice > MaxPrice {
		return fmt.Errorf("current price %s is outside the supported range", sku.CurrentPrice)
	}
	if prop.ProposedPrice <= 0 || prop.ProposedPrice > MaxPrice {
		return fmt.Errorf("proposed price %s is outside the supported range", prop.ProposedPrice)
	}
	if sku.UnitCost < 0 || sku.UnitCost > MaxPrice {
		return fmt.Errorf("unit cost %s is outside the supported range", sku.UnitCost)
	}
	if sku.MAPPrice < 0 || sku.MAPPrice > MaxPrice {
		return fmt.Errorf("MAP price %s is outside the supported range", sku.MAPPrice)
	}
	if prop.ConfidenceBP < 0 || prop.ConfidenceBP > OneHundredPercent {
		return fmt.Errorf("confidence %s must be between 0%% and 100%%", prop.ConfidenceBP)
	}
	return nil
}
