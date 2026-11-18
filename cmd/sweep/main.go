// Command sweep measures where the log-log elasticity estimator can be trusted,
// as a function of how many units a day a SKU sells, and derives the volume
// floor the product refuses below.
//
// For each demand level and each true elasticity it simulates many one-year
// histories with the volume gate OFF, fits each, and reports how often the
// stated 95% interval contained the truth and how far the mean estimate sits
// from it. Then it applies a criterion that was written down before the first
// run and is not adjusted afterwards:
//
//	a demand level passes when, for EVERY true elasticity, the lower 95%
//	binomial bound of the interval's coverage is at least 92% AND the relative
//	bias of the mean estimate is at most 3%.
//
// The floor is the smallest realised mean units a day among the three cells of
// the lowest level that passes with every higher level also passing, rounded up
// to a multiple of 5. "Realised" matters: the demand level is the model's
// expected daily units at the base price, and the units actually sold average
// somewhat more (seasonality, promotions and the lognormal shock are not mean
// preserving), so the gate compares the realised figure, not the label.
//
// Seeds are fixed in this file before any result is seen: trial t of cell c
// (levels outer, elasticities inner, from 0) uses seed 20261116 + c*1_000_000 + t.
//
//	go run ./cmd/sweep                 # 10,000 trials per cell (several minutes)
//	go run ./cmd/sweep -trials 200     # quick check; the verdicts are not meaningful
package main

import (
	"flag"
	"fmt"
	"math"
	"math/rand"
	"os"
	"runtime"
	"sync"

	"github.com/gkhurana21/pricepilot/enforcer"
	"github.com/gkhurana21/pricepilot/pricing"
)

const (
	baseSeed     = 20261116
	cellStride   = 1_000_000
	days         = 365
	proposalCost = enforcer.Cents(900) // the unit cost the red-team experiment used

	// The pass criterion. Fixed in advance; do not adjust after seeing results.
	minCoverageLower = 0.92
	maxRelBias       = 0.03
	floorMultiple    = 5.0
)

var (
	demandLevels = []float64{160, 80, 40, 20, 10, 7, 5, 4, 3, 2, 1}
	elasticities = []float64{-1.5, -2, -3}
)

// healthySchedule is the price schedule TestConfidenceIntervalsAreCalibrated
// uses: four levels held 14 days, a five-day 15% promotion every 45 days.
func healthySchedule() pricing.PriceSchedule {
	return pricing.PriceSchedule{
		Levels:          []enforcer.Cents{1800, 2000, 2200, 2400},
		HoldDays:        14,
		PromoEvery:      45,
		PromoDays:       5,
		PromoDiscountBP: 1500,
	}
}

// demandModel is the calibration test's model, with the base set so that the
// expected daily units at the $20 base price equal level.
func demandModel(level, beta float64) pricing.DemandModel {
	return pricing.DemandModel{
		SKUID:           "sku_sweep",
		BaseLogDemand:   math.Log(level) - beta*math.Log(20),
		Elasticity:      beta,
		WeeklySeasonAmp: 0.20,
		AnnualSeasonAmp: 0.15,
		PromoLift:       0.40,
		NoiseSD:         0.15,
	}
}

type trial struct {
	meanUnits float64
	usable    bool
	covered   bool
	elast     float64
	proposed  enforcer.Cents // zero when no proposal was made
}

type cell struct {
	level, beta float64
	index       int

	realised     float64 // mean over trials of MeanUnitsPerDay
	usable       int
	coverage     float64
	covLo, covHi float64
	meanEst      float64
	relBias      float64
	proposals    int
	meanProposed float64 // dollars
	trueOptimum  float64 // dollars
}

func runTrial(level, beta float64, seed int64) trial {
	rng := rand.New(rand.NewSource(seed))
	obs := demandModel(level, beta).Generate(healthySchedule(), days, rng)

	opt := pricing.DefaultFitOptions()
	opt.MinMeanUnitsPerDay = 0 // the sweep measures the estimator, so the gate is off

	est := pricing.EstimateElasticity("sku_sweep", obs, opt)
	t := trial{meanUnits: est.MeanUnitsPerDay}
	if !est.Usable() {
		return t
	}
	t.usable = true
	t.elast = est.Elasticity
	t.covered = est.CILow <= beta && beta <= est.CIHigh

	sku := enforcer.SKUState{ID: "sku_sweep", CurrentPrice: 2000, UnitCost: proposalCost}
	if prop, refusal, _ := pricing.Propose(est, sku); refusal == pricing.RefusalNone && prop.ProposedPrice > 0 {
		t.proposed = prop.ProposedPrice
	}
	return t
}

func runCell(level, beta float64, index, trials int) cell {
	results := make([]trial, trials)

	workers := runtime.NumCPU()
	var wg sync.WaitGroup
	next := make(chan int, trials)
	for i := 0; i < trials; i++ {
		next <- i
	}
	close(next)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				seed := int64(baseSeed + index*cellStride + i)
				results[i] = runTrial(level, beta, seed)
			}
		}()
	}
	wg.Wait()

	// Aggregate in trial order so the floating-point sums do not depend on
	// goroutine scheduling.
	c := cell{level: level, beta: beta, index: index}
	var unitsSum, estSum, propSum float64
	covered := 0
	for _, r := range results {
		unitsSum += r.meanUnits
		if !r.usable {
			continue
		}
		c.usable++
		estSum += r.elast
		if r.covered {
			covered++
		}
		if r.proposed > 0 {
			c.proposals++
			propSum += float64(r.proposed) / 100
		}
	}
	c.realised = unitsSum / float64(trials)
	if c.usable > 0 {
		c.coverage = float64(covered) / float64(c.usable)
		c.covLo, c.covHi = wilson(covered, c.usable)
		c.meanEst = estSum / float64(c.usable)
		c.relBias = math.Abs(c.meanEst-beta) / math.Abs(beta)
	}
	if c.proposals > 0 {
		c.meanProposed = propSum / float64(c.proposals)
	}
	if p, ok := pricing.OptimalPrice(proposalCost, beta); ok {
		c.trueOptimum = float64(p) / 100
	}
	return c
}

// wilson is the Wilson score interval for a binomial proportion at 95%.
func wilson(k, n int) (lo, hi float64) {
	z := pricing.NormalQuantile(0.975)
	nf, p := float64(n), float64(k)/float64(n)
	denom := 1 + z*z/nf
	centre := (p + z*z/(2*nf)) / denom
	half := z * math.Sqrt(p*(1-p)/nf+z*z/(4*nf*nf)) / denom
	return centre - half, centre + half
}

func (c cell) passes() bool {
	return c.usable > 0 && c.covLo >= minCoverageLower && c.relBias <= maxRelBias
}

func main() {
	trials := flag.Int("trials", 10000, "trials per cell")
	flag.Parse()
	if *trials < 1 {
		fmt.Fprintln(os.Stderr, "-trials must be at least 1")
		os.Exit(2)
	}

	fmt.Printf("# command: go run ./cmd/sweep -trials %d\n", *trials)
	fmt.Printf("# go version: %s %s/%s\n", runtime.Version(), runtime.GOOS, runtime.GOARCH)
	fmt.Printf("# seeds: trial t of cell c uses %d + c*%d + t; cells are numbered levels-outer, elasticities-inner, from 0\n",
		baseSeed, cellStride)
	fmt.Printf("# schedule: 4 price levels $18-$24 held 14 days, 5-day 15%% promo every 45 days, %d days; volume gate OFF\n", days)
	fmt.Printf("# criterion (fixed in advance): a level passes when, for every elasticity, the lower 95%% bound of\n")
	fmt.Printf("#   coverage is >= %.0f%% and relative bias is <= %.0f%%; the floor is the smallest realised mean units/day\n",
		minCoverageLower*100, maxRelBias*100)
	fmt.Printf("#   of the lowest level that passes with every higher level also passing, rounded up to a multiple of %.0f\n", floorMultiple)
	fmt.Printf("# proposals: unit cost %s, current price $20.00; mean proposed price is over trials that produced a proposal\n", proposalCost)
	if *trials < 10000 {
		fmt.Printf("# QUICK RUN: fewer than 10000 trials, so the intervals are wide and the verdicts below are not the published ones\n")
	}
	fmt.Println()

	fmt.Printf("%6s %6s %9s %7s %8s %-15s %8s %7s %9s %10s %9s %7s\n",
		"level", "beta", "realised", "usable", "cover%", "95% interval", "mean est", "bias%",
		"proposals", "mean prop", "true opt", "gap%")

	var cells []cell
	index := 0
	for _, level := range demandLevels {
		for _, beta := range elasticities {
			c := runCell(level, beta, index, *trials)
			cells = append(cells, c)
			index++

			gap := math.NaN()
			if c.proposals > 0 && c.trueOptimum > 0 {
				gap = (c.meanProposed - c.trueOptimum) / c.trueOptimum * 100
			}
			fmt.Printf("%6.0f %6.1f %9.2f %7d %7.2f%% [%5.2f, %6.2f]%% %8.3f %6.2f%% %9d %10s %9.2f %7s\n",
				c.level, c.beta, c.realised, c.usable, c.coverage*100, c.covLo*100, c.covHi*100,
				c.meanEst, c.relBias*100, c.proposals, dollars(c.meanProposed, c.proposals), c.trueOptimum, pct(gap))
		}
	}

	// Verdicts, per level.
	fmt.Println()
	fmt.Println("level verdicts (pass = every elasticity has coverage lower bound >= 92% and bias <= 3%):")
	passing := make([]bool, len(demandLevels))
	perLevel := len(elasticities)
	for li, level := range demandLevels {
		ok := true
		minRealised := math.Inf(1)
		for ei := range elasticities {
			c := cells[li*perLevel+ei]
			if !c.passes() {
				ok = false
			}
			minRealised = math.Min(minRealised, c.realised)
		}
		passing[li] = ok
		verdict := "FAIL"
		if ok {
			verdict = "PASS"
		}
		fmt.Printf("  level %3.0f  %s   (smallest realised mean among its cells: %.2f units/day)\n", level, verdict, minRealised)
	}

	// Floor: the lowest passing level with every higher level also passing.
	lowest := -1
	for li := range demandLevels {
		if !passing[li] {
			break
		}
		lowest = li
	}
	fmt.Println()
	if lowest < 0 {
		fmt.Println("NO LEVEL PASSES: not even the highest level meets the criterion, so no floor is derived.")
		if *trials >= 10000 {
			os.Exit(1) // a full run with no floor is a finding to report, not something to paper over
		}
		return // a quick run cannot pass: its intervals are too wide
	}
	minRealised := math.Inf(1)
	for ei := range elasticities {
		minRealised = math.Min(minRealised, cells[lowest*perLevel+ei].realised)
	}
	floor := math.Ceil(minRealised/floorMultiple) * floorMultiple
	fmt.Printf("lowest passing level with every higher level also passing: %.0f\n", demandLevels[lowest])
	fmt.Printf("smallest realised mean units/day among its cells: %.4f\n", minRealised)
	fmt.Printf("FLOOR (rounded up to a multiple of %.0f): %.0f units/day\n", floorMultiple, floor)
}

func dollars(v float64, n int) string {
	if n == 0 {
		return "-"
	}
	return fmt.Sprintf("%.2f", v)
}

func pct(v float64) string {
	if math.IsNaN(v) {
		return "-"
	}
	return fmt.Sprintf("%+.1f", v)
}
