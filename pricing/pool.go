package pricing

import (
	"fmt"
	"math"
	"sort"
)

// materialShrinkage is how far an estimate must be pulled before it is reported
// as pooled rather than as its own fit.
const materialShrinkage = 0.10

// Pool applies empirical-Bayes shrinkage across a collection of SKUs.
//
// Most SKUs in a real catalog have thin price histories, and their individual
// estimates are correspondingly noisy. Shrinking each toward the collection
// mean — by an amount set by its own precision — trades a little bias for a
// large variance reduction, and rescues SKUs whose standalone interval was too
// wide to price against.
//
// The weighting is DerSimonian-Laird random effects: a SKU with a tight
// interval barely moves, while one with a wide interval is pulled most of the
// way to its neighbours.
// PoolByGroup shrinks each SKU toward the mean of its own group.
//
// Pooling only borrows strength honestly between products that plausibly share
// a demand curve. Shrinking a $12 mug toward the mean of a catalog that also
// contains 1kg wholesale bags does not reduce error, it imports someone else's.
// Group by collection, product type, or price band — never the whole catalog.
func PoolByGroup(estimates []Estimate, groups []string, opt FitOptions) []Estimate {
	out := make([]Estimate, len(estimates))
	copy(out, estimates)
	if len(groups) != len(estimates) {
		return out
	}

	byGroup := map[string][]int{}
	for i, g := range groups {
		byGroup[g] = append(byGroup[g], i)
	}

	names := make([]string, 0, len(byGroup))
	for g := range byGroup {
		names = append(names, g)
	}
	sort.Strings(names) // deterministic order

	for _, g := range names {
		idx := byGroup[g]
		sub := make([]Estimate, len(idx))
		for j, i := range idx {
			sub[j] = estimates[i]
		}
		for j, e := range Pool(sub, opt) {
			out[idx[j]] = e
		}
	}
	return out
}

func Pool(estimates []Estimate, opt FitOptions) []Estimate {
	type contributor struct {
		idx  int
		beta float64
		v    float64 // within-SKU variance
	}

	var pool []contributor
	for i, e := range estimates {
		// Anything that produced a fit contributes, including estimates that
		// were individually rejected for imprecision or for the wrong sign.
		//
		// Dropping wrong-signed estimates before averaging would be selecting
		// on the outcome: it discards the left tail of the sampling
		// distribution and biases the pooled mean toward the result we were
		// hoping for. A confounded SKU normally carries a large standard error
		// and is down-weighted on its own merits.
		if e.StdErr > 0 && !math.IsNaN(e.Elasticity) && !math.IsInf(e.StdErr, 0) {
			pool = append(pool, contributor{i, e.Elasticity, e.StdErr * e.StdErr})
		}
	}

	out := make([]Estimate, len(estimates))
	copy(out, estimates)
	if len(pool) < 3 {
		return out // too few SKUs to borrow strength from
	}

	var sumW, sumWB, sumW2 float64
	for _, c := range pool {
		w := 1 / c.v
		sumW += w
		sumWB += w * c.beta
		sumW2 += w * w
	}
	fixedMean := sumWB / sumW

	var q float64
	for _, c := range pool {
		d := c.beta - fixedMean
		q += d * d / c.v
	}

	// Between-SKU variance. Clamped at zero: a negative estimate means the
	// data is consistent with every SKU sharing one elasticity.
	k := float64(len(pool))
	denom := sumW - sumW2/sumW
	tau2 := 0.0
	if denom > 0 {
		tau2 = math.Max(0, (q-(k-1))/denom)
	}

	var rSumW, rSumWB float64
	for _, c := range pool {
		w := 1 / (c.v + tau2)
		rSumW += w
		rSumWB += w * c.beta
	}
	grandMean := rSumWB / rSumW

	for _, c := range pool {
		e := &out[c.idx]

		var shrunk, se float64
		if tau2 <= 0 {
			// Complete pooling: every SKU takes the collection estimate.
			shrunk, se = grandMean, math.Sqrt(1/rSumW)
		} else {
			wi, wp := 1/c.v, 1/tau2
			shrunk = (c.beta*wi + grandMean*wp) / (wi + wp)
			se = math.Sqrt(1 / (wi + wp))
		}

		weight := 0.0
		if c.v+tau2 > 0 {
			weight = tau2 / (c.v + tau2) // 1 = keeps its own estimate, 0 = fully pooled
		}

		pull := 1 - weight // 0 = kept its own estimate, 1 = fully pooled

		e.Elasticity = shrunk
		e.StdErr = se
		half := TQuantile(1-(1-opt.Level)/2, maxInt(1, e.Days-2)) * se
		e.CILow, e.CIHigh = shrunk-half, shrunk+half
		e.Refusal = RefusalNone
		e.Shrinkage = pull

		// Only claim an estimate was pooled when pooling actually moved it. A
		// well-identified SKU that shifted two percent is still standing on its
		// own data, and labelling it "pooled" would misreport where the number
		// came from — which is the one thing this field exists to record.
		if pull >= materialShrinkage {
			e.Method = MethodPooled
			e.Note = fmt.Sprintf("shrunk %.0f%% toward the group mean of %.2f", pull*100, grandMean)
		} else {
			e.Method = MethodOLS
			e.Note = fmt.Sprintf("own data held; %.0f%% pull toward the group mean of %.2f", pull*100, grandMean)
		}

		// Shrinkage narrows an interval; it does not license a bad estimate.
		// The same acceptance gates apply to the pooled value.
		switch {
		case e.CILow <= 0 && e.CIHigh >= 0:
			e.Method, e.Refusal = MethodRefused, RefusalIndistinct
			e.Note = fmt.Sprintf("pooled interval [%.2f, %.2f] still contains zero", e.CILow, e.CIHigh)
		case e.Elasticity > 0:
			e.Method, e.Refusal = MethodRefused, RefusalWrongSign
			e.Note = fmt.Sprintf("pooled estimate %+.2f is still the wrong sign", e.Elasticity)
		case half/math.Abs(e.Elasticity) > opt.MaxRelativeHalfWidth:
			e.Method, e.Refusal = MethodRefused, RefusalImprecise
			e.Note = fmt.Sprintf("pooled interval [%.2f, %.2f] is still too wide to price against",
				e.CILow, e.CIHigh)
		}
	}

	return out
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
