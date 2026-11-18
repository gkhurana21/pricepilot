package pricing

import (
	"math"
	"math/rand"
	"strings"
	"testing"

	"github.com/gkhurana21/pricepilot/enforcer"
)

// handBuilt returns n observations over four price levels, one unit count each
// taken from units (cycled), so a test can state exactly what the estimator
// should report about them.
func handBuilt(n int, units []int) []Observation {
	prices := []enforcer.Cents{1800, 2000, 2200, 2400}
	obs := make([]Observation, n)
	for i := range obs {
		obs[i] = Observation{Day: i, Price: prices[(i/7)%len(prices)], Units: units[i%len(units)]}
	}
	return obs
}

// ZeroDays and MeanUnitsPerDay are the inputs to the volume gate, so their
// arithmetic is checked on a list small enough to count by hand.
func TestZeroDaysAndMeanUnitsPerDay(t *testing.T) {
	// 60 observations; the unit pattern 0,2,4,6,0,3 repeats 10 times:
	// 2 zero-unit days per 6, so 20 zero days, 40 days with sales, 15 units per
	// cycle, 150 units in all.
	obs := handBuilt(60, []int{0, 2, 4, 6, 0, 3})

	opt := DefaultFitOptions()
	opt.MinDays = 10 // below the 40 days with sales, so the days check passes
	est := EstimateElasticity("sku", obs, opt)

	if est.ZeroDays != 20 {
		t.Errorf("ZeroDays = %d, want 20", est.ZeroDays)
	}
	if want := 150.0 / 60.0; math.Abs(est.MeanUnitsPerDay-want) > 1e-12 {
		t.Errorf("MeanUnitsPerDay = %v, want %v (zero-sale days count in the denominator)", est.MeanUnitsPerDay, want)
	}
	if est.Days != 40 {
		t.Errorf("Days = %d, want 40 (days with sales, as before)", est.Days)
	}
}

// Zero-unit days are calendar days, not days of evidence: they must not help a
// history reach the 45-day minimum.
func TestZeroUnitDaysDoNotCountTowardMinDays(t *testing.T) {
	// 60 observations but only 40 with sales.
	obs := handBuilt(60, []int{0, 2, 4, 6, 0, 3})

	opt := DefaultFitOptions()
	opt.MinDays = 45
	est := EstimateElasticity("sku", obs, opt)

	if est.Refusal != RefusalTooFewDays {
		t.Fatalf("refusal = %q, want %q: 60 observations with 20 empty days is 40 days of sales", est.Refusal, RefusalTooFewDays)
	}
	if !strings.Contains(est.Note, "40 days of sales") {
		t.Errorf("note %q should report 40 days of sales", est.Note)
	}
	// The refusal still reports what it measured.
	if est.ZeroDays != 20 || est.MeanUnitsPerDay == 0 {
		t.Errorf("a refused estimate should still carry ZeroDays/MeanUnitsPerDay, got %d / %v", est.ZeroDays, est.MeanUnitsPerDay)
	}
}

// The gate refuses on average volume, after the checks that need no fit.
func TestVolumeGateRefusesBelowItsFloor(t *testing.T) {
	obs := handBuilt(100, []int{0, 2, 4, 6, 0, 3}) // 2.5 units a day on average

	opt := DefaultFitOptions()
	opt.MinMeanUnitsPerDay = 5
	est := EstimateElasticity("sku", obs, opt)
	if est.Refusal != RefusalVolumeTooLow || est.Usable() {
		t.Fatalf("got %q (usable=%v), want %q", est.Refusal, est.Usable(), RefusalVolumeTooLow)
	}
	if !strings.Contains(est.Note, "2.5 units a day on average") || !strings.Contains(est.Note, "5 or more") {
		t.Errorf("note %q should state the observed and required volume", est.Note)
	}

	// Zero disables the gate.
	opt.MinMeanUnitsPerDay = 0
	if est := EstimateElasticity("sku", obs, opt); est.Refusal == RefusalVolumeTooLow {
		t.Errorf("a zero floor must disable the gate, got %q", est.Refusal)
	}

	// A history with one price is refused for that reason first: the volume
	// gate does not mask the more basic problem.
	flat := handBuilt(100, []int{1})
	for i := range flat {
		flat[i].Price = 2000
	}
	opt.MinMeanUnitsPerDay = 5
	if est := EstimateElasticity("sku", flat, opt); est.Refusal != RefusalTooFewPrices {
		t.Errorf("single-price history refused as %q, want %q", est.Refusal, RefusalTooFewPrices)
	}
}

// pinModel is the sweep's demand model (cmd/sweep): the calibration test's
// shape, with the base set so the expected daily units at the $20 base price
// equal level.
func pinModel(level, beta float64) DemandModel {
	return DemandModel{
		SKUID:           "sku_pin",
		BaseLogDemand:   math.Log(level) - beta*math.Log(20),
		Elasticity:      beta,
		WeeklySeasonAmp: 0.20,
		AnnualSeasonAmp: 0.15,
		PromoLift:       0.40,
		NoiseSD:         0.15,
	}
}

// TestVolumeGateRegressionPin is a REGRESSION PIN, not the evidence.
//
// The evidence for the volume floor is the committed sweep,
// pricing/testdata/volume_sweep.txt (10,000 trials per cell, pre-declared
// seeds, criterion fixed in advance). This test runs a few hundred trials from
// its own fixed seeds so that CI notices if the estimator, the gate or the
// default floor drifts away from what that sweep measured. A few hundred trials
// cannot establish coverage to the precision the sweep does, so the bands here
// are deliberately loose.
func TestVolumeGateRegressionPin(t *testing.T) {
	const (
		trials   = 300
		pinSeed  = 77_000_000
		floorLvl = 40.0 // the demand level the sweep's criterion selected
	)
	betas := []float64{-1.5, -2, -3}

	// Above the floor the estimator's arithmetic is sound. Gate off, so this
	// measures the estimator at the floor's demand level and at 160 rather than
	// the realised-volume comparison the gate makes.
	for _, level := range []float64{floorLvl, 160} {
		for _, beta := range betas {
			covered, usable := 0, 0
			var estSum, unitsSum float64
			for i := 0; i < trials; i++ {
				rng := rand.New(rand.NewSource(int64(pinSeed + i)))
				obs := pinModel(level, beta).Generate(healthySchedule(), 365, rng)
				est := EstimateElasticity("sku_pin", obs, optionsWithoutVolumeGate())
				unitsSum += est.MeanUnitsPerDay
				if !est.Usable() {
					continue
				}
				usable++
				estSum += est.Elasticity
				if est.CILow <= beta && beta <= est.CIHigh {
					covered++
				}
			}
			if usable < trials*9/10 {
				t.Errorf("level %.0f beta %.1f: only %d/%d trials produced an estimate", level, beta, usable, trials)
				continue
			}
			cover := float64(covered) / float64(usable)
			bias := math.Abs(estSum/float64(usable)-beta) / math.Abs(beta)
			t.Logf("level %3.0f beta %4.1f: realised %.1f units/day, coverage %.1f%%, relative bias %.2f%% (%d usable of %d)",
				level, beta, unitsSum/trials, cover*100, bias*100, usable, trials)
			if cover < 0.89 || cover > 0.995 {
				t.Errorf("level %.0f beta %.1f: coverage %.1f%% outside the pin's band [89%%, 99.5%%]", level, beta, cover*100)
			}
			if bias > 0.04 {
				t.Errorf("level %.0f beta %.1f: relative bias %.2f%% above the pin's 4%% band", level, beta, bias*100)
			}
		}
	}

	// At 160 units a day the shipped options do not refuse for volume.
	{
		rng := rand.New(rand.NewSource(int64(pinSeed)))
		obs := pinModel(160, -2).Generate(healthySchedule(), 365, rng)
		if est := EstimateElasticity("sku_pin", obs, DefaultFitOptions()); est.Refusal == RefusalVolumeTooLow {
			t.Errorf("a SKU at 160 units a day was refused for volume under default options: %s", est.Note)
		}
	}

	// Well below the floor, every run is refused for volume under the shipped
	// options, whatever the true elasticity.
	for _, level := range []float64{10, 3} {
		for _, beta := range betas {
			for i := 0; i < trials; i++ {
				rng := rand.New(rand.NewSource(int64(pinSeed + i)))
				obs := pinModel(level, beta).Generate(healthySchedule(), 365, rng)
				est := EstimateElasticity("sku_pin", obs, DefaultFitOptions())
				if est.Refusal != RefusalVolumeTooLow || est.Usable() {
					t.Fatalf("level %.0f beta %.1f trial %d: refusal %q (usable=%v), want %q at %.1f units a day",
						level, beta, i, est.Refusal, est.Usable(), RefusalVolumeTooLow, est.MeanUnitsPerDay)
				}
			}
		}
	}
}
