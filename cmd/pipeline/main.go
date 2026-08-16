// Command pipeline runs PricePilot end to end on a synthetic catalog whose true
// elasticities are known: generate orders, estimate demand, pool sparse SKUs,
// propose prices, and put every proposal through the enforcer.
//
// Because the ground truth is known, the recovery error is printed per SKU.
// That is the whole reason the data is synthetic — on a real catalog you can
// measure that an estimate is stable, never that it is right.
//
//	go run ./cmd/pipeline
package main

import (
	"fmt"
	"math"
	"math/rand"
	"sort"
	"strings"
	"time"

	"github.com/gkhurana21/pricepilot/enforcer"
	"github.com/gkhurana21/pricepilot/pricing"
)

type product struct {
	name       string
	collection string
	trueBeta   float64
	cost       enforcer.Cents
	price      enforcer.Cents
	sched      pricing.PriceSchedule
	days       int
	noCost     bool
	note       string
}

func main() {
	rng := rand.New(rand.NewSource(20260816))
	now := time.Date(2026, 8, 16, 9, 0, 0, 0, time.UTC)

	rich := func(l ...enforcer.Cents) pricing.PriceSchedule {
		return pricing.PriceSchedule{Levels: l, HoldDays: 14, PromoEvery: 45, PromoDays: 5, PromoDiscountBP: 1500}
	}
	sparse := func(l ...enforcer.Cents) pricing.PriceSchedule {
		return pricing.PriceSchedule{Levels: l, HoldDays: 9}
	}

	catalog := []product{
		{name: "Ethiopia Yirgacheffe 250g", collection: "retail-beans", trueBeta: -2.4, cost: 900, price: 1620, sched: rich(1900, 2100, 2300, 2500), days: 365},
		{name: "Colombia Huila 250g", collection: "retail-beans", trueBeta: -1.9, cost: 1000, price: 1800, sched: rich(1600, 1800, 2000, 2200), days: 365},
		{name: "Kenya Nyeri AA 250g", collection: "retail-beans", trueBeta: -2.8, cost: 1100, price: 1780, sched: rich(2200, 2450, 2700, 2950), days: 365},
		{name: "Decaf Swiss Water 250g", collection: "retail-beans", trueBeta: -2.1, cost: 1050, price: 2300, sched: rich(2000, 2200, 2400, 2600), days: 365},
		{name: "Bramble House Blend 1kg", collection: "wholesale", trueBeta: -3.1, cost: 2200, price: 3350, sched: rich(4200, 4600, 5000, 5400), days: 365},

		{name: "Guatemala Antigua 250g", collection: "retail-beans", trueBeta: -2.2, cost: 980, price: 2100, sched: sparse(1950, 2100, 2250), days: 70, note: "10 weeks of history"},
		{name: "Brazil Cerrado 250g", collection: "retail-beans", trueBeta: -2.0, cost: 880, price: 1900, sched: sparse(1750, 1900, 2050), days: 70, note: "10 weeks of history"},
		{name: "Sumatra Mandheling 250g", collection: "retail-beans", trueBeta: -2.5, cost: 1020, price: 2250, sched: sparse(2100, 2250, 2400), days: 70, note: "10 weeks of history"},
		{name: "Peru Cajamarca 250g", collection: "retail-beans", trueBeta: -1.8, cost: 940, price: 2000, sched: sparse(1850, 2000, 2150), days: 70, note: "10 weeks of history"},

		{name: "Chemex Classic 6-cup", collection: "equipment", trueBeta: -2.0, cost: 3100, price: 5200, sched: pricing.PriceSchedule{Levels: []enforcer.Cents{5200}, HoldDays: 400}, days: 365, note: "never repriced"},
		{name: "Hario V60 Filters 100ct", collection: "equipment", trueBeta: -1.5, cost: 700, price: 1200, sched: pricing.PriceSchedule{Levels: []enforcer.Cents{1200, 1250}, HoldDays: 180}, days: 365, note: "two prices, one switch"},

		{name: "Signature Roast Mug", collection: "merch", trueBeta: -0.6, cost: 800, price: 1800, sched: rich(1500, 1700, 1900, 2100), days: 365, note: "inelastic"},
		{name: "Travel Tumbler 350ml", collection: "merch", trueBeta: -2.3, cost: 2600, price: 3200, sched: rich(2900, 3100, 3300, 3500), days: 365, noCost: true, note: "no unit cost recorded"},
	}

	policy := enforcer.Policy{
		ID: "pol_bramble_coffee", Version: 5,
		MarginFloor:      enforcer.MarginFloor{Basis: enforcer.MarginOnPrice, Rate: 3500},
		MaxDecreaseBP:    1500,
		MaxIncreaseBP:    1500,
		Rounding:         enforcer.RoundCharm99,
		MinChangeBP:      200,
		MinConfidenceBP:  6000,
		MaxSKUsChangedBP: 10000,
		Velocity:         enforcer.Velocity{MinDaysBetweenChanges: 14, MaxChangesPerWindow: 2, WindowDays: 90},
	}

	opt := pricing.DefaultFitOptions()

	fmt.Printf("\n  PricePilot — end-to-end run on a synthetic catalog\n")
	fmt.Printf("  %d SKUs · true elasticities known · policy %s v%d\n",
		len(catalog), policy.ID, policy.Version)
	fmt.Println("  " + strings.Repeat("─", 100))

	// ---- 1. generate + estimate ------------------------------------------
	ests := make([]pricing.Estimate, len(catalog))
	for i, p := range catalog {
		m := pricing.DemandModel{
			SKUID: p.name, Elasticity: p.trueBeta,
			BaseLogDemand:   3.7 - p.trueBeta*math.Log(float64(p.price)/100),
			WeeklySeasonAmp: 0.20, AnnualSeasonAmp: 0.15, PromoLift: 0.40, NoiseSD: 0.15,
		}
		obs := m.Generate(p.sched, p.days, rng)
		ests[i] = pricing.EstimateElasticity(p.name, obs, opt)
	}

	standalone := countUsable(ests)

	// ---- 2. pool within collections ---------------------------------------
	groups := make([]string, len(catalog))
	for i, p := range catalog {
		groups[i] = p.collection
	}
	pooled := pricing.PoolByGroup(ests, groups, opt)
	rescued := countUsable(pooled) - standalone

	fmt.Printf("\n  ESTIMATION            (β recovered against known truth; pooling is within collection)\n\n")
	fmt.Printf("    %-27s %-13s %7s %8s %8s  %-20s %s\n",
		"", "collection", "true β", "est β", "err", "95% interval", "source")
	for i, p := range catalog {
		e := pooled[i]
		if !e.Usable() {
			fmt.Printf("    %-27s %-13s %7.2f %8s %8s  %-20s refused: %s\n",
				trunc(p.name, 27), p.collection, p.trueBeta, "—", "—", "—", e.Refusal)
			continue
		}
		err := math.Abs(e.Elasticity-p.trueBeta) / math.Abs(p.trueBeta) * 100
		src := "own data"
		if e.Method == pricing.MethodPooled {
			src = fmt.Sprintf("pooled %.0f%%", e.Shrinkage*100)
		}
		flag := " "
		if err > 15 {
			flag = "*"
		}
		fmt.Printf("    %-27s %-13s %7.2f %8.2f %6.1f%%%s %-20s %s\n",
			trunc(p.name, 27), p.collection, p.trueBeta, e.Elasticity, err, flag,
			fmt.Sprintf("[%.2f, %.2f]", e.CILow, e.CIHigh), src)
	}
	fmt.Printf("\n    %d of %d estimable standalone; pooling rescued %d more    (* = outside the 15%% target)\n",
		standalone, len(catalog), rescued)

	// ---- 3. propose -------------------------------------------------------
	var items []enforcer.Item
	var declined []string
	for i, p := range catalog {
		sku := enforcer.SKUState{
			ID: p.name, VariantGID: "gid://shopify/ProductVariant/" + p.name,
			CurrentPrice: p.price, UnitCost: p.cost,
		}
		if p.noCost {
			sku.UnitCost = 0
		}

		prop, refusal, note := pricing.Propose(pooled[i], sku)
		if refusal != pricing.RefusalNone || prop.ProposedPrice == 0 {
			if note == "" {
				note = string(refusal)
			}
			declined = append(declined, fmt.Sprintf("%-28s %s", trunc(p.name, 28), note))
			continue
		}
		items = append(items, enforcer.Item{SKU: sku, Proposal: prop})
	}

	fmt.Printf("\n  PROPOSAL\n\n")
	fmt.Printf("    %d proposals generated; %d SKUs produced none\n\n", len(items), len(declined))
	for _, d := range declined {
		fmt.Printf("      · %s\n", d)
	}

	// ---- 4. enforce -------------------------------------------------------
	res := enforcer.DecideBatch(enforcer.Request{Policy: policy, Now: now, Items: items})

	fmt.Printf("\n  ENFORCEMENT\n\n")
	for _, d := range res.Decisions {
		switch d.Action {
		case enforcer.ActionReject:
			fmt.Printf("    %-28s %8s  →  %-9s  %s\n", trunc(d.SKUID, 28), d.CurrentPrice,
				"no change", lastReason(d))
		default:
			how := "model's price"
			if d.BoundByPolicy() {
				how = "held by " + string(bindingRule(d))
			}
			fmt.Printf("    %-28s %8s  →  %-9s %+7.2f%%   margin %.1f%%   %s\n",
				trunc(d.SKUID, 28), d.CurrentPrice, d.FinalPrice,
				float64(d.DeltaBP)/100, float64(d.MarginBP)/100, how)
		}
	}

	s := res.Summary
	fmt.Println("\n  " + strings.Repeat("─", 100))
	held := 0
	for _, d := range res.Decisions {
		if d.Action != enforcer.ActionReject && d.BoundByPolicy() {
			held++
		}
	}
	fmt.Printf("  funnel:  %d SKUs  →  %d estimable  →  %d proposals  →  %d applied\n",
		len(catalog), countUsable(pooled), len(items), s.Approved+s.Clamped)
	fmt.Printf("  of those applied, %d were held back by a guardrail and %d took the model's price\n",
		held, s.Approved+s.Clamped-held)
	if len(s.RejectedByRule) > 0 {
		fmt.Printf("  held back by:")
		for _, rule := range sortedRules(s.RejectedByRule) {
			fmt.Printf("  %s×%d", rule, s.RejectedByRule[rule])
		}
		fmt.Println()
	}
	fmt.Printf("\n  %d of %d SKUs reached a price change. On a real catalog that ratio is the\n", s.Approved+s.Clamped, len(catalog))
	fmt.Printf("  product working: most SKUs lack the price variation to estimate anything.\n\n")
}

func countUsable(e []pricing.Estimate) int {
	n := 0
	for _, x := range e {
		if x.Usable() {
			n++
		}
	}
	return n
}

// bindingRule names the guardrail that actually moved the price, ignoring the
// cosmetic rounding step.
func bindingRule(d enforcer.Decision) enforcer.RuleID {
	for _, r := range d.Reasons {
		if r.Effect == enforcer.EffectClamped && r.Rule != enforcer.RuleRounding {
			return r.Rule
		}
	}
	return ""
}

func lastReason(d enforcer.Decision) string {
	if len(d.Reasons) == 0 {
		return ""
	}
	return d.Reasons[len(d.Reasons)-1].Message
}

func sortedRules(m map[enforcer.RuleID]int) []enforcer.RuleID {
	out := make([]enforcer.RuleID, 0, len(m))
	for r := range m {
		out = append(out, r)
	}
	sort.Slice(out, func(a, b int) bool {
		if m[out[a]] != m[out[b]] {
			return m[out[a]] > m[out[b]]
		}
		return out[a] < out[b]
	})
	return out
}

func trunc(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
