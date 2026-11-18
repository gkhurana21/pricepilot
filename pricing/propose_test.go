package pricing

import (
	"math"
	"math/rand"
	"testing"

	"github.com/gkhurana21/pricepilot/enforcer"
)

func TestOptimalPriceMath(t *testing.T) {
	tests := []struct {
		cost enforcer.Cents
		beta float64
		want enforcer.Cents
		ok   bool
		why  string
	}{
		{500, -2.0, 1000, true, "beta=-2 is a 100% markup"},
		{500, -3.0, 750, true, "beta=-3 is a 50% markup"},
		{500, -1.5, 1500, true, "beta=-1.5 is a 200% markup"},
		{1000, -4.0, 1333, true, "more elastic demand means a thinner margin"},
		{500, -1.0, 0, false, "at beta=-1 there is no interior optimum"},
		{500, -0.5, 0, false, "inelastic demand has no finite optimum"},
		{500, 0.5, 0, false, "positive elasticity is not a demand curve"},
		{0, -2.0, 0, false, "no cost, no optimum"},
	}
	for _, tc := range tests {
		got, ok := OptimalPrice(tc.cost, tc.beta)
		if ok != tc.ok {
			t.Errorf("%s: ok = %v, want %v", tc.why, ok, tc.ok)
			continue
		}
		if ok && got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.why, got, tc.want)
		}
	}
}

// The consequence of the promo confounder, priced in dollars.
//
// The bias is not an academic point about a coefficient: it flows straight
// through the optimal-price formula into what the merchant charges.
func TestPromoConfounderCostsRealMargin(t *testing.T) {
	m := model(-2.0)
	m.PromoLift = 0.9
	rng := rand.New(rand.NewSource(4242))
	obs := m.Generate(healthySchedule(), 365, rng)

	naive := DefaultFitOptions()
	naive.ControlPromo = false

	withCtl := EstimateElasticity("sku", obs, DefaultFitOptions())
	without := EstimateElasticity("sku", obs, naive)

	const cost enforcer.Cents = 1000
	truePrice, _ := OptimalPrice(cost, m.Elasticity)
	goodPrice, _ := OptimalPrice(cost, withCtl.Elasticity)
	badPrice, _ := OptimalPrice(cost, without.Elasticity)

	gap := float64(truePrice-badPrice) / float64(truePrice) * 100
	t.Logf("unit cost %s | true optimum %s | with promo control %s | without %s",
		cost, truePrice, goodPrice, badPrice)
	t.Logf("omitting one control underprices by %.1f%%", gap)

	if badPrice >= truePrice {
		t.Fatalf("the naive estimate should underprice: got %s vs %s", badPrice, truePrice)
	}
	if gap < 10 {
		t.Errorf("underpricing of %.1f%% is too small to demonstrate the stakes", gap)
	}
	if math.Abs(float64(goodPrice-truePrice))/float64(truePrice) > 0.12 {
		t.Errorf("the controlled estimate should land near the true optimum: %s vs %s", goodPrice, truePrice)
	}
}

// An estimate whose interval reaches beta = -1 must not produce a proposal, even
// when its point estimate looks comfortably elastic. The optimal-price formula
// has a discontinuity there, so the midpoint of such an interval is a confident
// number resting on nothing.
func TestIntervalReachingInelasticRegionProposesNothing(t *testing.T) {
	est := Estimate{
		SKUID: "sku", Method: MethodOLS, Level: 0.95,
		Elasticity: -1.25, StdErr: 0.16, CILow: -1.57, CIHigh: -0.93,
		Days: 200, DistinctPrices: 4,
	}
	sku := enforcer.SKUState{ID: "sku", CurrentPrice: 3000, UnitCost: 1000}

	_, refusal, note := Propose(est, sku)
	if refusal == RefusalNone {
		t.Fatalf("expected a refusal for an interval reaching -0.93")
	}
	t.Logf("refused: %s — %s", refusal, note)
}

func TestProposalCarriesItsEvidence(t *testing.T) {
	m := model(-2.2)
	rng := rand.New(rand.NewSource(77))
	obs := m.Generate(healthySchedule(), 365, rng)

	est := EstimateElasticity("sku", obs, optionsWithoutVolumeGate())
	if !est.Usable() {
		t.Fatalf("estimator refused: %s", est.Note)
	}

	sku := enforcer.SKUState{ID: "sku", CurrentPrice: 2000, UnitCost: 900}
	prop, refusal, note := Propose(est, sku)
	if refusal != RefusalNone {
		t.Fatalf("unexpected refusal %s: %s", refusal, note)
	}

	if prop.ProposedPrice <= 0 {
		t.Fatal("proposal carries no price")
	}
	if prop.ConfidenceBP <= 0 || prop.ConfidenceBP > enforcer.OneHundredPercent {
		t.Errorf("confidence %s is out of range", prop.ConfidenceBP)
	}
	if len(prop.Signals) < 3 {
		t.Errorf("a proposal must carry its evidence; got %d signals", len(prop.Signals))
	}
	if prop.Rationale == "" {
		t.Error("a proposal must explain itself")
	}
	t.Logf("proposed %s (conf %s): %s", prop.ProposedPrice, prop.ConfidenceBP, prop.Rationale)
	for _, s := range prop.Signals {
		t.Logf("  %s: %s", s.Name, s.Description)
	}
}

// Pooling exists to help SKUs whose own histories are too thin to price
// against. This measures whether it actually does, rather than assuming it.
func TestPoolingImprovesSparseEstimates(t *testing.T) {
	const skus = 40
	rng := rand.New(rand.NewSource(2026))

	// A collection of similar products: elasticities scattered around -2.0.
	trueBeta := make([]float64, skus)
	raw := make([]Estimate, skus)

	opt := optionsWithoutVolumeGate()
	opt.MinDays = 20
	opt.MaxRelativeHalfWidth = 10 // keep noisy fits so pooling has work to do
	var unitsSum float64

	for i := 0; i < skus; i++ {
		trueBeta[i] = -2.0 + rng.NormFloat64()*0.25
		m := model(trueBeta[i])
		// Thin histories: two price points held briefly, ~10 weeks of data.
		sched := PriceSchedule{
			Levels:   []enforcer.Cents{1900, 2100, 2300},
			HoldDays: 9,
		}
		obs := m.Generate(sched, 70, rng)
		raw[i] = EstimateElasticity("sku", obs, opt)
		unitsSum += raw[i].MeanUnitsPerDay
	}

	pooled := Pool(raw, opt)

	var mseRaw, msePooled float64
	counted := 0
	for i := range raw {
		if raw[i].StdErr <= 0 {
			continue
		}
		dr := raw[i].Elasticity - trueBeta[i]
		dp := pooled[i].Elasticity - trueBeta[i]
		mseRaw += dr * dr
		msePooled += dp * dp
		counted++
	}
	if counted < skus/2 {
		t.Fatalf("only %d/%d SKUs produced a fit", counted, skus)
	}
	mseRaw /= float64(counted)
	msePooled /= float64(counted)

	t.Logf("%d sparse SKUs: MSE %.4f standalone -> %.4f pooled (%.0f%% reduction)",
		counted, mseRaw, msePooled, (1-msePooled/mseRaw)*100)
	t.Logf("  (volume gate off for this test; realised %.1f units a day, mean over the %d SKUs)", unitsSum/skus, skus)

	if msePooled >= mseRaw {
		t.Errorf("pooling did not reduce error: %.4f -> %.4f", mseRaw, msePooled)
	}
}

// Excluding wrong-signed estimates before averaging would select on the
// outcome and bias the pooled mean. This pins the decision to include them.
func TestPoolIncludesWrongSignedEstimates(t *testing.T) {
	opt := DefaultFitOptions()
	ests := []Estimate{
		{SKUID: "a", Elasticity: -2.0, StdErr: 0.10, Days: 200, Method: MethodOLS},
		{SKUID: "b", Elasticity: -2.1, StdErr: 0.12, Days: 200, Method: MethodOLS},
		{SKUID: "c", Elasticity: -1.9, StdErr: 0.11, Days: 200, Method: MethodOLS},
		{SKUID: "d", Elasticity: +0.6, StdErr: 0.90, Days: 200, Method: MethodRefused, Refusal: RefusalWrongSign},
	}

	pooled := Pool(ests, opt)

	// The confounded SKU is pulled toward its neighbours rather than discarded.
	if pooled[3].Elasticity >= 0 {
		t.Errorf("wrong-signed SKU stayed positive after pooling: %.3f", pooled[3].Elasticity)
	}
	// Its large standard error means it barely moves the others.
	if math.Abs(pooled[0].Elasticity-(-2.0)) > 0.25 {
		t.Errorf("a single noisy outlier distorted a precise estimate: %.3f", pooled[0].Elasticity)
	}
	t.Logf("outlier %+.2f (se %.2f) pooled to %+.3f; precise neighbour -2.00 -> %.3f",
		ests[3].Elasticity, ests[3].StdErr, pooled[3].Elasticity, pooled[0].Elasticity)
}
