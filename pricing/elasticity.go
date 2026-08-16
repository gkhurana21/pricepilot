package pricing

import (
	"fmt"
	"math"

	"github.com/gkhurana21/pricepilot/enforcer"
)

// Method records how an estimate was produced, so nothing downstream has to
// guess whether a number came from a SKU's own data or was borrowed.
type Method string

const (
	MethodOLS     Method = "ols"     // the SKU's own history carried the estimate
	MethodPooled  Method = "pooled"  // shrunk toward its collection
	MethodRefused Method = "refused" // no estimate; see Refusal
)

// Refusal names why no usable estimate exists. These are first-class outcomes,
// not errors: on a real catalog most SKUs land here, and saying so plainly is
// the product working correctly.
type Refusal string

const (
	RefusalNone            Refusal = ""
	RefusalTooFewDays      Refusal = "too_few_days"
	RefusalTooFewPrices    Refusal = "too_few_distinct_prices"
	RefusalNoPriceVariance Refusal = "insufficient_price_variation"
	RefusalSingular        Refusal = "collinear_regressors"
	RefusalIndistinct      Refusal = "not_distinguishable_from_zero"
	RefusalWrongSign       Refusal = "implausible_positive_elasticity"
	RefusalImprecise       Refusal = "interval_too_wide"
)

// Estimate is one SKU's demand elasticity, with everything a reader needs to
// judge how much to trust it.
type Estimate struct {
	SKUID string

	Elasticity float64 // point estimate; negative means demand falls as price rises
	StdErr     float64
	CILow      float64
	CIHigh     float64
	Level      float64 // the interval's confidence level, e.g. 0.95

	Days           int
	DistinctPrices int
	LogPriceSD     float64 // the variation the estimate actually rests on
	RSquared       float64
	PromoControl   bool

	// Controls lists the regressors that survived into the fit. A control with
	// no variation in this SKU's history is dropped, so this is the honest
	// record of what the estimate actually adjusted for.
	Controls []string

	// Shrinkage records how far pooling pulled this estimate toward its group,
	// from 0 (kept its own data entirely) to 1 (took the group mean outright).
	Shrinkage float64

	Method  Method
	Refusal Refusal
	Note    string
}

// Usable reports whether this estimate may drive a price proposal.
func (e Estimate) Usable() bool { return e.Method != MethodRefused }

// ConfidenceBP maps interval precision onto the 0-10000 scale the enforcer
// reads, as one minus the half-width expressed as a fraction of the point
// estimate. An interval of -2.0 +/- 0.4 scores 8000; one of -2.0 +/- 2.0
// scores 0.
//
// This is a precision heuristic and deliberately not called a probability.
// Nothing here estimates the chance that a price change succeeds, and naming it
// that way would invite exactly the over-reading this project is trying to
// avoid.
func (e Estimate) ConfidenceBP() enforcer.BasisPoints {
	if !e.Usable() || e.Elasticity == 0 {
		return 0
	}
	half := (e.CIHigh - e.CILow) / 2
	rel := half / math.Abs(e.Elasticity)
	switch {
	case rel <= 0:
		return enforcer.OneHundredPercent
	case rel >= 1:
		return 0
	}
	return enforcer.BasisPoints(math.Round((1 - rel) * float64(enforcer.OneHundredPercent)))
}

// FitOptions controls the specification and the bar an estimate must clear.
type FitOptions struct {
	ControlPromo      bool
	WeeklySeasonality bool
	AnnualSeasonality bool

	Level                float64 // interval level, e.g. 0.95
	MinDays              int
	MinDistinctPrices    int
	MinLogPriceSD        float64
	MaxRelativeHalfWidth float64 // refuse when the interval is wider than this fraction of the estimate
}

// DefaultFitOptions is the specification used in tests and the demo.
func DefaultFitOptions() FitOptions {
	return FitOptions{
		ControlPromo:      true,
		WeeklySeasonality: true,
		AnnualSeasonality: true,

		Level:             0.95,
		MinDays:           45,
		MinDistinctPrices: 3,

		// Roughly a 2% spread in log price. Below this the slope is being read
		// off noise, however many orders sit behind it.
		MinLogPriceSD:        0.02,
		MaxRelativeHalfWidth: 0.60,
	}
}

// EstimateElasticity fits log(units) on log(price) with optional controls.
//
// The refusals are the substance of this function. Elasticity is identified by
// variation in price, not by volume of sales: ten thousand orders at a single
// price contain exactly zero information about what happens at a different one.
// An estimator that answers anyway is worse than useless, because the number it
// returns looks just like a real one.
func EstimateElasticity(skuID string, obs []Observation, opt FitOptions) Estimate {
	est := Estimate{
		SKUID:        skuID,
		Level:        opt.Level,
		Days:         len(obs),
		Method:       MethodRefused,
		PromoControl: opt.ControlPromo,
	}

	if len(obs) < opt.MinDays {
		est.Refusal = RefusalTooFewDays
		est.Note = fmt.Sprintf("%d days of sales; %d needed", len(obs), opt.MinDays)
		return est
	}

	prices := map[enforcer.Cents]bool{}
	logP := make([]float64, 0, len(obs))
	for _, o := range obs {
		if o.Price <= 0 || o.Units <= 0 {
			continue
		}
		prices[o.Price] = true
		logP = append(logP, math.Log(float64(o.Price)/100))
	}
	est.DistinctPrices = len(prices)
	est.LogPriceSD = stddev(logP)

	if est.DistinctPrices < opt.MinDistinctPrices {
		est.Refusal = RefusalTooFewPrices
		est.Note = fmt.Sprintf("sold at %d distinct price(s); elasticity needs at least %d",
			est.DistinctPrices, opt.MinDistinctPrices)
		return est
	}
	if est.LogPriceSD < opt.MinLogPriceSD {
		est.Refusal = RefusalNoPriceVariance
		est.Note = fmt.Sprintf("log-price variation of %.4f is too small to identify a slope", est.LogPriceSD)
		return est
	}

	y, x, controls := designMatrix(obs, opt)
	est.Controls = controls
	fit, err := FitOLS(y, x)
	if err != nil {
		est.Refusal = RefusalSingular
		est.Note = err.Error()
		return est
	}

	const priceCol = 1 // [intercept, log price, ...surviving controls]
	est.Elasticity = fit.Coef[priceCol]
	est.StdErr = fit.StdErr[priceCol]
	est.CILow, est.CIHigh = fit.ConfInterval(priceCol, opt.Level)
	est.RSquared = fit.RSquared

	if est.CILow <= 0 && est.CIHigh >= 0 {
		est.Refusal = RefusalIndistinct
		est.Note = fmt.Sprintf("interval [%.2f, %.2f] contains zero; the data does not establish that price moves demand",
			est.CILow, est.CIHigh)
		return est
	}
	if est.Elasticity > 0 {
		est.Refusal = RefusalWrongSign
		est.Note = fmt.Sprintf("estimated %+.2f: demand rising with price means something else is driving both, not a demand curve",
			est.Elasticity)
		return est
	}
	half := (est.CIHigh - est.CILow) / 2
	if half/math.Abs(est.Elasticity) > opt.MaxRelativeHalfWidth {
		est.Refusal = RefusalImprecise
		est.Note = fmt.Sprintf("%.2f with interval [%.2f, %.2f] is too imprecise to price against",
			est.Elasticity, est.CILow, est.CIHigh)
		return est
	}

	est.Method = MethodOLS
	return est
}

// designMatrix builds [intercept, log price, ...controls] and drops any control
// with no variation in this SKU's history.
//
// That filtering is not a nicety. A promo indicator for a SKU that never went
// on promo is a column of zeros, which makes X'X singular and kills the fit
// outright — and most SKUs in a real catalog never go on promo. An earlier
// version returned "collinear regressors" for all of them. A control that
// cannot vary carries no information and must be omitted, not fatal.
//
// Seasonality enters as sin/cos pairs rather than day-of-week dummies: two
// columns instead of six, which matters when a SKU has only a few months of
// history.
func designMatrix(obs []Observation, opt FitOptions) ([]float64, [][]float64, []string) {
	type column struct {
		name string
		v    []float64
	}

	y := make([]float64, 0, len(obs))
	rows := make([]Observation, 0, len(obs))
	for _, o := range obs {
		if o.Price <= 0 || o.Units <= 0 {
			continue
		}
		y = append(y, math.Log(float64(o.Units)))
		rows = append(rows, o)
	}

	logPrice := make([]float64, len(rows))
	for i, o := range rows {
		logPrice[i] = math.Log(float64(o.Price) / 100)
	}

	var optional []column
	if opt.ControlPromo {
		v := make([]float64, len(rows))
		for i, o := range rows {
			if o.OnPromo {
				v[i] = 1
			}
		}
		optional = append(optional, column{"promo", v})
	}
	if opt.WeeklySeasonality {
		sin := make([]float64, len(rows))
		cos := make([]float64, len(rows))
		for i, o := range rows {
			sin[i] = math.Sin(2 * math.Pi * float64(o.Day) / 7)
			cos[i] = math.Cos(2 * math.Pi * float64(o.Day) / 7)
		}
		optional = append(optional, column{"weekly_sin", sin}, column{"weekly_cos", cos})
	}
	if opt.AnnualSeasonality {
		sin := make([]float64, len(rows))
		cos := make([]float64, len(rows))
		for i, o := range rows {
			sin[i] = math.Sin(2 * math.Pi * float64(o.Day) / 365)
			cos[i] = math.Cos(2 * math.Pi * float64(o.Day) / 365)
		}
		optional = append(optional, column{"annual_sin", sin}, column{"annual_cos", cos})
	}

	kept := []column{{"intercept", nil}, {"log_price", logPrice}}
	names := []string{}
	for _, c := range optional {
		if !constantColumn(c.v) {
			kept = append(kept, c)
			names = append(names, c.name)
		}
	}

	x := make([][]float64, len(rows))
	for i := range rows {
		row := make([]float64, len(kept))
		row[0] = 1
		for j := 1; j < len(kept); j++ {
			row[j] = kept[j].v[i]
		}
		x[i] = row
	}
	return y, x, names
}

// constantColumn reports whether a regressor has no usable variation, scaled to
// its own magnitude so the test means the same thing for an indicator as for a
// harmonic.
func constantColumn(v []float64) bool {
	if len(v) < 2 {
		return true
	}
	lo, hi := v[0], v[0]
	for _, f := range v {
		lo = math.Min(lo, f)
		hi = math.Max(hi, f)
	}
	scale := math.Max(math.Abs(lo), math.Abs(hi))
	if scale == 0 {
		return true
	}
	return (hi-lo)/scale < 1e-9
}

func stddev(v []float64) float64 {
	if len(v) < 2 {
		return 0
	}
	var mean float64
	for _, f := range v {
		mean += f
	}
	mean /= float64(len(v))
	var ss float64
	for _, f := range v {
		d := f - mean
		ss += d * d
	}
	return math.Sqrt(ss / float64(len(v)-1))
}
