package pricing

import (
	"fmt"
	"math"

	"github.com/gkhurana21/pricepilot/enforcer"
)

// OptimalPrice returns the profit-maximising price under constant-elasticity
// demand: maximising (p-c)·A·p^β gives p* = c·β/(1+β).
//
// The formula only has an interior solution when β < -1. At β >= -1 demand is
// inelastic and the model says revenue rises without limit as price rises,
// which is a statement about the model's domain, not about the business. That
// boundary is why Propose refuses rather than returning a very large number.
func OptimalPrice(cost enforcer.Cents, beta float64) (enforcer.Cents, bool) {
	if cost <= 0 || math.IsNaN(beta) || beta >= -1 {
		return 0, false
	}
	p := float64(cost) * beta / (1 + beta)
	if math.IsInf(p, 0) || math.IsNaN(p) || p <= 0 || p > float64(enforcer.MaxPrice) {
		return 0, false
	}
	return enforcer.Cents(math.Round(p)), true
}

// Propose turns an elasticity estimate into a price proposal for the enforcer.
//
// It refuses in three situations the estimator alone cannot catch, and the
// third is the one worth reading twice.
func Propose(est Estimate, sku enforcer.SKUState) (enforcer.Proposal, Refusal, string) {
	if !est.Usable() {
		return enforcer.Proposal{}, est.Refusal, est.Note
	}
	if sku.UnitCost <= 0 {
		return enforcer.Proposal{}, RefusalNone,
			"no unit cost on this variant, so there is no margin to optimise"
	}

	// A point estimate of -1.2 looks elastic, but if its interval reaches -0.9
	// then the data is consistent with a world where no optimal price exists at
	// all. Pricing off the midpoint of an interval that straddles a
	// discontinuity is how a confident number becomes a wrong one.
	if est.CIHigh >= -1 {
		return enforcer.Proposal{}, RefusalImprecise, fmt.Sprintf(
			"interval [%.2f, %.2f] reaches the inelastic region where no profit-maximising price exists",
			est.CILow, est.CIHigh)
	}

	optimal, ok := OptimalPrice(sku.UnitCost, est.Elasticity)
	if !ok {
		return enforcer.Proposal{}, RefusalWrongSign, fmt.Sprintf(
			"elasticity %.2f implies no interior optimum", est.Elasticity)
	}

	// The interval on beta maps to an interval on price, so the merchant can
	// see how much of the proposed move is actually pinned down.
	lo, _ := OptimalPrice(sku.UnitCost, est.CILow)
	hi, _ := OptimalPrice(sku.UnitCost, est.CIHigh)

	signals := []enforcer.Signal{
		{
			Name:       "elasticity",
			ContribuBP: enforcer.BasisPoints(math.Round(est.Elasticity * 100)),
			Description: fmt.Sprintf("%.2f [%.2f, %.2f] from %d days across %d prices",
				est.Elasticity, est.CILow, est.CIHigh, est.Days, est.DistinctPrices),
		},
		{
			Name:       "optimal_price_range",
			ContribuBP: 0,
			Description: fmt.Sprintf("margin-optimal %s, interval implies %s to %s",
				optimal, lo, hi),
		},
		{
			Name:        "fit_quality",
			ContribuBP:  enforcer.BasisPoints(math.Round(est.RSquared * 10000)),
			Description: fmt.Sprintf("R²=%.3f, method %s", est.RSquared, est.Method),
		},
	}
	if est.Method == MethodPooled {
		signals = append(signals, enforcer.Signal{
			Name:        "pooled",
			Description: "estimate shrunk toward its collection because this SKU's own history was thin",
		})
	}

	return enforcer.Proposal{
		SKUID:         sku.ID,
		ProposedPrice: optimal,
		ConfidenceBP:  est.ConfidenceBP(),
		Rationale: fmt.Sprintf("elasticity %.2f implies a margin-optimal price of %s against a %s unit cost",
			est.Elasticity, optimal, sku.UnitCost),
		Signals: signals,
	}, RefusalNone, ""
}
