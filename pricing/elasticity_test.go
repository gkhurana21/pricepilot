package pricing

import (
	"math"
	"math/rand"
	"testing"

	"github.com/gkhurana21/pricepilot/enforcer"
)

// TestTQuantileMatchesTables pins the interval arithmetic against published
// values. Every confidence interval in this package is only as trustworthy as
// this function, so it is checked rather than assumed.
func TestTQuantileMatchesTables(t *testing.T) {
	tests := []struct {
		df   int
		want float64
	}{
		{10, 2.228}, {15, 2.131}, {20, 2.086}, {30, 2.042},
		{60, 2.000}, {120, 1.980}, {1000, 1.962},
	}
	for _, tc := range tests {
		got := TQuantile(0.975, tc.df)
		if math.Abs(got-tc.want) > 0.001 {
			t.Errorf("t(0.975, %d) = %.4f, want %.3f", tc.df, got, tc.want)
		}
	}
	if z := NormalQuantile(0.975); math.Abs(z-1.959964) > 1e-6 {
		t.Errorf("z(0.975) = %.6f, want 1.959964", z)
	}
}

func healthySchedule() PriceSchedule {
	return PriceSchedule{
		Levels:          []enforcer.Cents{1800, 2000, 2200, 2400},
		HoldDays:        14,
		PromoEvery:      45,
		PromoDays:       5,
		PromoDiscountBP: 1500,
	}
}

func model(beta float64) DemandModel {
	return DemandModel{
		SKUID:           "sku_test",
		BaseLogDemand:   3.7 - beta*math.Log(20),
		Elasticity:      beta,
		WeeklySeasonAmp: 0.20,
		AnnualSeasonAmp: 0.15,
		PromoLift:       0.40,
		NoiseSD:         0.15,
	}
}

// The exit criterion from the PRD: on data whose true elasticity is known, the
// estimator recovers it within 15%.
func TestRecoversKnownElasticity(t *testing.T) {
	for _, beta := range []float64{-1.4, -1.8, -2.5, -3.2} {
		m := model(beta)
		rng := rand.New(rand.NewSource(int64(beta * -1000)))
		obs := m.Generate(healthySchedule(), 365, rng)

		est := EstimateElasticity("sku_test", obs, DefaultFitOptions())
		if !est.Usable() {
			t.Fatalf("beta=%.1f: refused (%s: %s)", beta, est.Refusal, est.Note)
		}

		relErr := math.Abs(est.Elasticity-beta) / math.Abs(beta)
		t.Logf("true %.2f -> estimated %.3f [%.3f, %.3f]  err %.1f%%  R2=%.3f  conf=%s",
			beta, est.Elasticity, est.CILow, est.CIHigh, relErr*100, est.RSquared, est.ConfidenceBP())

		if relErr > 0.15 {
			t.Errorf("beta=%.2f: recovered %.3f, off by %.1f%% (limit 15%%)", beta, est.Elasticity, relErr*100)
		}
		if est.CILow > beta || est.CIHigh < beta {
			t.Errorf("beta=%.2f: 95%% interval [%.3f, %.3f] misses the truth", beta, est.CILow, est.CIHigh)
		}
	}
}

// A stated 95% interval must contain the truth about 95% of the time. An
// interval that is merely printed, never checked, is decoration.
func TestConfidenceIntervalsAreCalibrated(t *testing.T) {
	const trials = 600
	const beta = -2.0

	covered, usable := 0, 0
	for i := 0; i < trials; i++ {
		m := model(beta)
		rng := rand.New(rand.NewSource(int64(9000 + i)))
		obs := m.Generate(healthySchedule(), 365, rng)

		est := EstimateElasticity("sku_test", obs, DefaultFitOptions())
		if !est.Usable() {
			continue
		}
		usable++
		if est.CILow <= beta && beta <= est.CIHigh {
			covered++
		}
	}

	if usable < trials/2 {
		t.Fatalf("only %d/%d trials produced an estimate", usable, trials)
	}
	rate := float64(covered) / float64(usable)
	t.Logf("95%% interval covered the truth in %d/%d usable trials (%.1f%%)", covered, usable, rate*100)

	if rate < 0.90 || rate > 0.99 {
		t.Errorf("coverage %.1f%% is not consistent with a 95%% interval", rate*100)
	}
}

// The headline limitation of demand estimation, made executable.
//
// Elasticity is identified by variation in price. A SKU with an enormous order
// history at a single price contains no information about what happens at a
// different price, and an estimator that produces a number anyway is dangerous
// precisely because that number looks exactly like a real one.
func TestVolumeWithoutPriceVariationIdentifiesNothing(t *testing.T) {
	m := model(-2.0)
	m.BaseLogDemand += 3 // enormous volume: thousands of units a day
	rng := rand.New(rand.NewSource(11))

	obs := m.Generate(PriceSchedule{Levels: []enforcer.Cents{2000}, HoldDays: 400}, 365, rng)

	var units int
	for _, o := range obs {
		units += o.Units
	}
	t.Logf("%d days, %d total units, 1 distinct price", len(obs), units)

	est := EstimateElasticity("sku_test", obs, DefaultFitOptions())
	if est.Usable() {
		t.Fatalf("estimated %.3f from %d units at a single price; must refuse", est.Elasticity, units)
	}
	if est.Refusal != RefusalTooFewPrices && est.Refusal != RefusalNoPriceVariance {
		t.Errorf("refusal = %q, want a price-variation refusal", est.Refusal)
	}
	t.Logf("refused: %s — %s", est.Refusal, est.Note)
}

// Promotions cut price and raise demand at the same time. An estimator that
// ignores them credits the whole promotional lift to the price cut and reports
// demand as far more elastic than it is — the same shape of error as training
// on a feature that encodes the outcome.
func TestOmittingPromoBiasesElasticityDownward(t *testing.T) {
	m := model(-2.0)
	m.PromoLift = 0.9 // a strong email blast

	rng := rand.New(rand.NewSource(4242))
	obs := m.Generate(healthySchedule(), 365, rng)

	controlled := DefaultFitOptions()
	naive := DefaultFitOptions()
	naive.ControlPromo = false

	withCtl := EstimateElasticity("sku_test", obs, controlled)
	without := EstimateElasticity("sku_test", obs, naive)

	if !withCtl.Usable() || !without.Usable() {
		t.Fatalf("both specifications must produce an estimate; got %q and %q",
			withCtl.Refusal, without.Refusal)
	}

	t.Logf("true %.2f | with promo control %.3f | without %.3f | bias %+.3f",
		m.Elasticity, withCtl.Elasticity, without.Elasticity,
		without.Elasticity-withCtl.Elasticity)

	if math.Abs(withCtl.Elasticity-m.Elasticity) > 0.15 {
		t.Errorf("controlled estimate %.3f should be near the true %.2f", withCtl.Elasticity, m.Elasticity)
	}
	if without.Elasticity >= withCtl.Elasticity {
		t.Errorf("omitting the promo control should overstate elasticity: got %.3f vs %.3f",
			without.Elasticity, withCtl.Elasticity)
	}
	// The bias must be big enough to matter commercially, not just detectable.
	if withCtl.Elasticity-without.Elasticity < 0.10 {
		t.Errorf("bias of %.3f is too small to demonstrate the confounder",
			withCtl.Elasticity-without.Elasticity)
	}
}

// A SKU that never went on promo must still be estimable.
//
// With the promo control requested but never varying, the indicator is a column
// of zeros and X'X is singular. An earlier version refused every such SKU with
// "collinear regressors" — which is most of a real catalog, since most products
// never go on promotion at all.
func TestSKUThatNeverPromotedIsStillEstimable(t *testing.T) {
	m := model(-2.1)
	m.PromoLift = 0
	rng := rand.New(rand.NewSource(303))

	noPromo := PriceSchedule{
		Levels:   []enforcer.Cents{1800, 2000, 2200, 2400},
		HoldDays: 14,
	}
	obs := m.Generate(noPromo, 365, rng)

	for _, o := range obs {
		if o.OnPromo {
			t.Fatal("schedule should contain no promotions")
		}
	}

	est := EstimateElasticity("sku", obs, DefaultFitOptions())
	if !est.Usable() {
		t.Fatalf("refused a SKU that simply never promoted: %s — %s", est.Refusal, est.Note)
	}
	for _, c := range est.Controls {
		if c == "promo" {
			t.Error("a promo control with no variation must be dropped, not fitted")
		}
	}
	t.Logf("estimated %.3f [%.3f, %.3f] with controls %v",
		est.Elasticity, est.CILow, est.CIHigh, est.Controls)

	if math.Abs(est.Elasticity-m.Elasticity)/math.Abs(m.Elasticity) > 0.15 {
		t.Errorf("recovered %.3f, want near %.2f", est.Elasticity, m.Elasticity)
	}
}
