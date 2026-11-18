package pricing

import (
	"math"
	"math/rand"
	"testing"
	"time"

	"github.com/gkhurana21/pricepilot/enforcer"
)

// TestEstimatorNeverProducesAnUnenforceableProposal walks the full chain —
// generate, estimate, pool, propose, enforce — across many random catalogs.
//
// The two halves of this system are developed against different standards: the
// estimator is judged statistically and the enforcer is judged absolutely. This
// is the seam between them, and the point is that no statistical outcome,
// however extreme, can produce a price that violates the merchant's policy.
func TestEstimatorNeverProducesAnUnenforceableProposal(t *testing.T) {
	now := time.Date(2026, 8, 16, 9, 0, 0, 0, time.UTC)
	rng := rand.New(rand.NewSource(515))

	policy := enforcer.Policy{
		ID:              "integration",
		MarginFloor:     enforcer.MarginFloor{Basis: enforcer.MarginOnPrice, Rate: 3500},
		MaxDecreaseBP:   1500,
		MaxIncreaseBP:   1500,
		Rounding:        enforcer.RoundCharm99,
		MinChangeBP:     200,
		MinConfidenceBP: 6000,
	}
	if err := policy.Validate(); err != nil {
		t.Fatalf("test policy is invalid: %v", err)
	}

	opt := optionsWithoutVolumeGate()
	proposals, applied := 0, 0
	var unitsSum float64

	for trial := 0; trial < 400; trial++ {
		beta := -3.5 + rng.Float64()*3.2 // spans elastic through inelastic
		cost := enforcer.Cents(500 + rng.Intn(3000))
		current := enforcer.Cents(float64(cost) * (1.2 + rng.Float64()*1.8))

		m := DemandModel{
			SKUID: "sku", Elasticity: beta,
			BaseLogDemand:   3.7 - beta*math.Log(float64(current)/100),
			WeeklySeasonAmp: 0.2, AnnualSeasonAmp: 0.15, PromoLift: 0.4, NoiseSD: 0.2,
		}

		levels := []enforcer.Cents{current}
		if rng.Intn(4) > 0 { // most SKUs get real price variation, some do not
			for k := 1; k < 4; k++ {
				levels = append(levels, enforcer.Cents(float64(current)*(1+0.08*float64(k))))
			}
		}
		obs := m.Generate(PriceSchedule{
			Levels: levels, HoldDays: 14,
			PromoEvery: 45, PromoDays: 5, PromoDiscountBP: 1500,
		}, 200+rng.Intn(200), rng)

		est := EstimateElasticity("sku", obs, opt)
		unitsSum += est.MeanUnitsPerDay
		sku := enforcer.SKUState{ID: "sku", CurrentPrice: current, UnitCost: cost}

		prop, refusal, _ := Propose(est, sku)
		if refusal != RefusalNone || prop.ProposedPrice == 0 {
			continue
		}
		proposals++

		d := enforcer.Decide(policy, sku, prop, now)
		if d.Action == enforcer.ActionReject {
			continue
		}
		applied++

		// The enforcer's guarantees must hold regardless of what the estimator
		// asked for.
		floor := enforcer.Cents(math.Ceil(float64(cost) * 10000 / (10000 - 3500)))
		if d.FinalPrice < floor {
			t.Fatalf("trial %d: applied %s below the %s margin floor (cost %s, beta %.2f)",
				trial, d.FinalPrice, floor, cost, beta)
		}
		minAllowed := enforcer.Cents(math.Ceil(float64(current) * 0.85))
		maxAllowed := enforcer.Cents(math.Floor(float64(current) * 1.15))
		if d.FinalPrice < minAllowed || d.FinalPrice > maxAllowed {
			t.Fatalf("trial %d: applied %s outside the per-cycle band [%s, %s]",
				trial, d.FinalPrice, minAllowed, maxAllowed)
		}
		if prop.ConfidenceBP < policy.MinConfidenceBP {
			t.Fatalf("trial %d: a %s proposal cleared the %s confidence bar",
				trial, prop.ConfidenceBP, policy.MinConfidenceBP)
		}
	}

	t.Logf("400 catalogs: %d produced a proposal, %d survived the policy", proposals, applied)
	t.Logf("  (volume gate off for this test; realised %.1f units a day, mean over the 400 catalogs)", unitsSum/400)
	if proposals == 0 {
		t.Fatal("no proposals reached the enforcer; the seam is untested")
	}
	if applied == 0 {
		t.Fatal("no proposal survived the policy; the seam is untested")
	}
}

// Inelastic SKUs must never reach the enforcer. The optimal-price formula has
// no interior solution at beta >= -1, so a proposal there would be the model
// extrapolating past its own domain.
func TestInelasticSKUsNeverReachTheEnforcer(t *testing.T) {
	rng := rand.New(rand.NewSource(808))
	checked := 0

	for _, beta := range []float64{-0.3, -0.5, -0.75, -0.9} {
		m := DemandModel{
			SKUID: "sku", Elasticity: beta,
			BaseLogDemand:   3.7 - beta*math.Log(20),
			WeeklySeasonAmp: 0.2, AnnualSeasonAmp: 0.15, NoiseSD: 0.15,
		}
		obs := m.Generate(healthySchedule(), 365, rng)
		est := EstimateElasticity("sku", obs, optionsWithoutVolumeGate())
		t.Logf("beta=%.2f (volume gate off for this test; realised %.1f units a day)", beta, est.MeanUnitsPerDay)
		sku := enforcer.SKUState{ID: "sku", CurrentPrice: 2000, UnitCost: 800}

		prop, refusal, note := Propose(est, sku)
		if refusal == RefusalNone && prop.ProposedPrice != 0 {
			t.Errorf("beta=%.2f: proposed %s where no optimum exists (est %.2f [%.2f, %.2f])",
				beta, prop.ProposedPrice, est.Elasticity, est.CILow, est.CIHigh)
			continue
		}
		checked++
		t.Logf("beta=%.2f estimated %.2f [%.2f, %.2f] -> refused: %s",
			beta, est.Elasticity, est.CILow, est.CIHigh, note)
	}

	if checked == 0 {
		t.Fatal("no inelastic case was exercised")
	}
}
