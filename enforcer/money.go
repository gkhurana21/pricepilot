package enforcer

import "fmt"

// Cents is a monetary amount in minor units. Money is never a float in this
// package: every bound, margin, and rounding step is integer arithmetic, so a
// price that survives the engine is exactly the price that reaches the catalog.
type Cents int64

func (c Cents) String() string {
	neg := ""
	if c < 0 {
		neg, c = "-", -c
	}
	return fmt.Sprintf("%s%d.%02d", neg, int64(c)/100, int64(c)%100)
}

// BasisPoints expresses a rate in hundredths of a percent. 10000 bp == 100%.
// Percentages are never stored as floats; 12.5% is 1250, not 0.125.
type BasisPoints int32

const OneHundredPercent BasisPoints = 10000

func (b BasisPoints) String() string {
	neg := ""
	if b < 0 {
		neg, b = "-", -b
	}
	return fmt.Sprintf("%s%d.%02d%%", neg, int32(b)/100, int32(b)%100)
}

// mulBP returns c * bp / 10000, rounded toward negative infinity.
func mulBP(c Cents, bp BasisPoints) Cents {
	return floorDiv(int64(c)*int64(bp), int64(OneHundredPercent))
}

// mulBPCeil returns c * bp / 10000, rounded toward positive infinity. Used
// wherever rounding down would relax a floor by a cent.
func mulBPCeil(c Cents, bp BasisPoints) Cents {
	return ceilDiv(int64(c)*int64(bp), int64(OneHundredPercent))
}

func floorDiv(a, b int64) Cents {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return Cents(q)
}

func ceilDiv(a, b int64) Cents {
	q := a / b
	if (a%b != 0) && ((a < 0) == (b < 0)) {
		q++
	}
	return Cents(q)
}

// deltaBP is the signed change from base to price, in basis points. Magnitude
// rounds away from zero so a change can never be reported as smaller than it is.
func deltaBP(base, price Cents) BasisPoints {
	if base == 0 {
		return 0
	}
	diff := int64(price - base)
	num := diff * int64(OneHundredPercent)
	den := int64(base)
	var q int64
	if (num < 0) != (den < 0) {
		q = int64(floorDiv(num, den))
		if num%den != 0 {
			// floorDiv already rounded away from zero for negatives
		}
	} else {
		q = int64(ceilDiv(num, den))
	}
	return BasisPoints(q)
}

func absBP(b BasisPoints) BasisPoints {
	if b < 0 {
		return -b
	}
	return b
}
