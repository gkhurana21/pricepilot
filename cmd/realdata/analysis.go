package main

import (
	"math"
	"sort"

	"github.com/gkhurana21/pricepilot/enforcer"
	"github.com/gkhurana21/pricepilot/pricing"
)

// allRefusals is every code EstimateElasticity can return, in the order it
// checks them, so the funnel lists each one even when its count is zero.
var allRefusals = []pricing.Refusal{
	pricing.RefusalTooFewDays,
	pricing.RefusalTooFewPrices,
	pricing.RefusalNoPriceVariance,
	pricing.RefusalVolumeTooLow,
	pricing.RefusalSingular,
	pricing.RefusalIndistinct,
	pricing.RefusalWrongSign,
	pricing.RefusalImprecise,
}

type product struct {
	Code   string
	Desc   string
	Lines  []line
	Units  int
	Obs    []pricing.Observation
	Prices int // distinct prices on days with sales
	On     pricing.Estimate
	Off    pricing.Estimate
}

func distinctSalePrices(obs []pricing.Observation) int {
	seen := map[enforcer.Cents]bool{}
	for _, o := range obs {
		if o.Units > 0 {
			seen[o.Price] = true
		}
	}
	return len(seen)
}

// funnel counts products and units refused under each code.
type funnel struct {
	Products   int
	Units      int
	Refused    map[pricing.Refusal]int
	RefusedU   map[pricing.Refusal]int
	Usable     int
	UsableU    int
	BelowMinus int // usable with elasticity < -1
	TotalUnits int // all kept units, the denominator for unit shares
}

func makeFunnel(ests []pricing.Estimate, units []int) funnel {
	f := funnel{Refused: map[pricing.Refusal]int{}, RefusedU: map[pricing.Refusal]int{}}
	for i, e := range ests {
		f.Products++
		f.Units += units[i]
		if e.Usable() {
			f.Usable++
			f.UsableU += units[i]
			if e.Elasticity < -1 {
				f.BelowMinus++
			}
			continue
		}
		f.Refused[e.Refusal]++
		f.RefusedU[e.Refusal] += units[i]
	}
	f.TotalUnits = f.Units
	return f
}

// quantile is the type-7 sample quantile (linear interpolation between order
// statistics) of sorted values.
func quantile(sorted []float64, p float64) float64 {
	n := len(sorted)
	if n == 0 {
		return math.NaN()
	}
	h := float64(n-1) * p
	lo := math.Floor(h)
	hi := math.Ceil(h)
	return sorted[int(lo)] + (h-lo)*(sorted[int(hi)]-sorted[int(lo)])
}

func sortedCopy(v []float64) []float64 {
	out := append([]float64(nil), v...)
	sort.Float64s(out)
	return out
}

// productDay is one product on one day it sold.
type productDay struct {
	prices map[enforcer.Cents]bool
	units  int
}

// multiPriceDays is confounding measure (i): over (product, day) pairs with
// at least one kept line, how many carried more than one distinct price, and
// how many units sold on those pairs.
func multiPriceDays(lines []line) (pairs, multi, units, multiUnits int) {
	type key struct {
		p string
		d int
	}
	m := map[key]*productDay{}
	for _, l := range lines {
		k := key{l.Product, l.Day}
		pd := m[k]
		if pd == nil {
			pd = &productDay{prices: map[enforcer.Cents]bool{}}
			m[k] = pd
		}
		pd.prices[l.Pence] = true
		pd.units += l.Qty
	}
	for _, pd := range m {
		pairs++
		units += pd.units
		if len(pd.prices) > 1 {
			multi++
			multiUnits += pd.units
		}
	}
	return
}

// sizeSplit is confounding measure (ii) for one product: units-weighted mean
// price of lines at or above the lower-median quantity ("large") and below it
// ("small"). ok is false when either group is empty.
func sizeSplit(lines []line) (large, small float64, ok bool) {
	m := lowerMedianQty(lines)
	var lu, lv, su, sv float64
	for _, l := range lines {
		q := float64(l.Qty)
		if l.Qty >= m {
			lu += q
			lv += q * float64(l.Pence)
		} else {
			su += q
			sv += q * float64(l.Pence)
		}
	}
	if lu == 0 || su == 0 {
		return 0, 0, false
	}
	return lv / lu, sv / su, true
}

// retailLines keeps a product's lines whose quantity is at or below its
// lower-median line quantity: confounding measure (iii).
func retailLines(lines []line) []line {
	m := lowerMedianQty(lines)
	var out []line
	for _, l := range lines {
		if l.Qty <= m {
			out = append(out, l)
		}
	}
	return out
}

// sameDaySplit is confounding measure (iv), added after review of (ii): (ii)
// pools a product's lines across two years, so a price that rose over time
// while order sizes fell would also make large lines look cheaper. This one
// cannot be explained by time. It looks only inside a single product-day that
// had more than one price, and asks whether the lines at that day's lowest
// price were larger, on average, than the lines at its highest price.
func sameDaySplit(lines []line) (days, lowPriceLarger, equal int) {
	type key struct {
		p string
		d int
	}
	type agg struct{ qty, n int }
	m := map[key]map[enforcer.Cents]*agg{}
	for _, l := range lines {
		k := key{l.Product, l.Day}
		if m[k] == nil {
			m[k] = map[enforcer.Cents]*agg{}
		}
		a := m[k][l.Pence]
		if a == nil {
			a = &agg{}
			m[k][l.Pence] = a
		}
		a.qty += l.Qty
		a.n++
	}
	for _, byPrice := range m {
		if len(byPrice) < 2 {
			continue
		}
		var lo, hi enforcer.Cents
		first := true
		for p := range byPrice {
			if first || p < lo {
				lo = p
			}
			if first || p > hi {
				hi = p
			}
			first = false
		}
		days++
		// Compare mean line quantity at the lowest and highest price by
		// cross-multiplying, so no float is involved.
		a, b := byPrice[lo], byPrice[hi]
		left, right := a.qty*b.n, b.qty*a.n
		switch {
		case left > right:
			lowPriceLarger++
		case left == right:
			equal++
		}
	}
	return
}
