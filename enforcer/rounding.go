package enforcer

// roundWithin snaps target to the nearest price matching the rounding pattern
// that still lies inside [lo, hi].
//
// This is the subtlest rule in the engine. Rounding is conventionally applied
// last, which means a naive implementation can undo every bound that came
// before it: a $10.00 margin floor with .99 endings rounds a $10.02 proposal
// down to $9.99 and quietly ships a sub-floor price. So rounding here is a
// constrained search, never a post-hoc transform — it may only select values
// the bounds already permit.
//
// Returns the rounded price and whether a compliant pattern value exists. When
// none does (the interval is narrower than the pattern spacing), the caller
// keeps the unrounded price: a correct price beats a pretty one.
func roundWithin(target, lo, hi Cents, m RoundingMode) (Cents, bool) {
	if !m.Enabled || m.Modulus <= 0 {
		return target, false
	}
	if lo > hi {
		return target, false
	}

	residue := ((m.Residue % m.Modulus) + m.Modulus) % m.Modulus

	below := patternFloor(target, m.Modulus, residue)
	above := below
	if below < target {
		above = below + m.Modulus
	}

	belowOK := below >= lo && below <= hi
	aboveOK := above >= lo && above <= hi

	switch {
	case belowOK && aboveOK:
		dBelow := target - below
		dAbove := above - target
		// Ties round up. Every active lower bound is a floor (margin, MAP,
		// max-decrease) while upper bounds are rarer, so upward is the safer
		// direction to break a tie in.
		if dAbove <= dBelow {
			return above, true
		}
		return below, true
	case belowOK:
		return below, true
	case aboveOK:
		return above, true
	}

	// Target's own neighbours are out of range, but the interval may still
	// contain a pattern value further out.
	first := patternCeil(lo, m.Modulus, residue)
	if first >= lo && first <= hi {
		return first, true
	}
	return target, false
}

// patternFloor returns the largest v <= x with v % modulus == residue.
func patternFloor(x, modulus, residue Cents) Cents {
	d := ((x-residue)%modulus + modulus) % modulus
	return x - d
}

// patternCeil returns the smallest v >= x with v % modulus == residue.
func patternCeil(x, modulus, residue Cents) Cents {
	v := patternFloor(x, modulus, residue)
	if v < x {
		v += modulus
	}
	return v
}
