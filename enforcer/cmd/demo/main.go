// Command demo runs one repricing cycle for a fictional coffee retailer and
// prints the review a merchant would approve or reject.
//
// It opens with the changes that were refused, because that is the part of the
// product worth trusting: anyone can propose a price.
//
//	go run ./cmd/demo
package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/gkhurana21/pricepilot/enforcer"
)

func main() {
	now := time.Date(2026, 8, 16, 9, 0, 0, 0, time.UTC)

	policy := enforcer.Policy{
		ID:      "pol_bramble_coffee",
		Version: 4,
		MarginFloor: enforcer.MarginFloor{
			Basis: enforcer.MarginOnPrice,
			Rate:  4000, // never sell below a 40% gross margin
		},
		RespectMAP:    true,
		MaxDecreaseBP: 1500, // at most 15% down in one cycle
		MaxIncreaseBP: 1000, // at most 10% up
		Velocity: enforcer.Velocity{
			MinDaysBetweenChanges: 14,
			MaxChangesPerWindow:   2,
			WindowDays:            90,
		},
		Exclusions:       enforcer.Exclusions{Tags: []string{"subscription"}},
		Rounding:         enforcer.RoundCharm99,
		MinChangeBP:      200, // don't bother the catalog for less than 2%
		MinConfidenceBP:  6000,
		MaxSKUsChangedBP: 5000, // never move more than half the run
	}

	items := []enforcer.Item{
		item("Ethiopia Yirgacheffe 250g", 2200, 1100, 0, nil, 0, time.Time{}, 1899, 9200,
			"demand elastic at current price; 34 days of cover"),
		item("Colombia Huila 250g", 1800, 1080, 0, nil, 0, time.Time{}, 1400, 8800,
			"sell-through down 22% week over week"),
		item("Chemex Classic 6-cup", 5200, 3100, 4900, nil, 0, time.Time{}, 4200, 8500,
			"competitor set moved down; inventory aging past 90 days"),
		item("Baratza Encore Grinder", 17900, 12500, 16900, nil, 0, time.Time{}, 15200, 9100,
			"high price sensitivity in category"),
		item("Monthly Roaster's Pick", 2400, 1200, 0, []string{"subscription"}, 0, time.Time{}, 2100, 9400,
			"subscription pricing under review"),
		item("Kenya Nyeri AA 250g", 2600, 1300, 0, nil, 1, now.AddDate(0, 0, -5), 2350, 8700,
			"margin headroom after cost decrease"),
		item("Cold Brew Concentrate", 1500, 900, 0, nil, 0, time.Time{}, 1350, 4200,
			"only 6 orders in 90 days"),
		item("Bramble House Blend 1kg", 4800, 2400, 0, nil, 0, time.Time{}, 5400, 9000,
			"consistently sells out before restock"),
		item("Hario V60 Filters 100ct", 1200, 700, 0, nil, 0, time.Time{}, 1200, 9300,
			"no signal to move"),
		item("Guatemala Antigua 250g", 2100, 1450, 0, nil, 0, time.Time{}, 1750, 8900,
			"clearing remaining lot"),
		item("Travel Tumbler 350ml", 3200, 2600, 0, nil, 0, time.Time{}, 2900, 7800,
			"slow mover, thin margin"),
		item("Decaf Swiss Water 250g", 2300, 1150, 0, nil, 0, time.Time{}, 2050, 9600,
			"steady demand, room to optimise"),
	}

	res := enforcer.DecideBatch(enforcer.Request{Policy: policy, Now: now, Items: items})

	fmt.Printf("\n  PricePilot — repricing review\n")
	fmt.Printf("  policy %s v%d  ·  %s  ·  %s\n",
		policy.ID, policy.Version, res.PolicyHash, now.Format(time.DateOnly))
	fmt.Println("  " + strings.Repeat("─", 96))

	section("HELD BACK — the agent proposed these and the policy refused", res, items,
		func(d enforcer.Decision) bool { return d.Action == enforcer.ActionReject })

	section("ADJUSTED — proposal moved to the nearest compliant price", res, items,
		func(d enforcer.Decision) bool { return d.Action == enforcer.ActionClamp })

	section("APPROVED — cleared every guardrail unchanged", res, items,
		func(d enforcer.Decision) bool { return d.Action == enforcer.ActionApprove })

	s := res.Summary
	fmt.Println("  " + strings.Repeat("─", 96))
	fmt.Printf("  %d proposals  ·  %d approved  ·  %d adjusted  ·  %d held back  (%d increases, %d decreases)\n",
		s.Total, s.Approved, s.Clamped, s.Rejected, s.Increases, s.Decreases)
	if len(s.RejectedByRule) > 0 {
		fmt.Printf("  held back by:")
		for _, rule := range ruleOrder {
			if n := s.RejectedByRule[rule]; n > 0 {
				fmt.Printf("  %s×%d", rule, n)
			}
		}
		fmt.Println()
	}
	fmt.Printf("\n  Nothing above has been applied. Approving writes these prices and stores a\n")
	fmt.Printf("  snapshot; one click restores every prior price exactly.\n\n")

	if s.Approved+s.Clamped == 0 {
		fmt.Fprintln(os.Stderr, "no changes to apply")
	}
}

var ruleOrder = []enforcer.RuleID{
	enforcer.RuleExcluded, enforcer.RuleConfidence, enforcer.RuleVelocityDays,
	enforcer.RuleVelocityCount, enforcer.RuleInfeasible, enforcer.RuleNoChange,
	enforcer.RuleInvalidInput, enforcer.RuleBatchBudget,
}

func section(title string, res enforcer.Result, items []enforcer.Item, match func(enforcer.Decision) bool) {
	var idx []int
	for i, d := range res.Decisions {
		if match(d) {
			idx = append(idx, i)
		}
	}
	if len(idx) == 0 {
		return
	}

	fmt.Printf("\n  %s\n\n", title)
	for _, i := range idx {
		d := res.Decisions[i]
		name := items[i].SKU.ID

		if d.Action == enforcer.ActionReject {
			fmt.Printf("    %-28s %8s  →  %-10s\n", trunc(name, 28), d.CurrentPrice, "no change")
		} else {
			fmt.Printf("    %-28s %8s  →  %-8s  %+.2f%%   margin %.1f%%\n",
				trunc(name, 28), d.CurrentPrice, d.FinalPrice,
				float64(d.DeltaBP)/100, float64(d.MarginBP)/100)
		}
		for _, r := range d.Reasons {
			if r.Effect == enforcer.EffectBound {
				continue // bounds are context; show only what acted
			}
			fmt.Printf("      %s %s\n", marker(r.Effect), r.Message)
		}
	}
}

func marker(e enforcer.Effect) string {
	switch e {
	case enforcer.EffectBlocked:
		return "×"
	case enforcer.EffectClamped:
		return "→"
	default:
		return "·"
	}
}

func trunc(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

func item(name string, current, cost, mapPrice enforcer.Cents, tags []string,
	changesInWindow int, lastChange time.Time, proposed enforcer.Cents,
	confidence enforcer.BasisPoints, rationale string) enforcer.Item {
	return enforcer.Item{
		SKU: enforcer.SKUState{
			ID:                name,
			VariantGID:        "gid://shopify/ProductVariant/" + name,
			CurrentPrice:      current,
			UnitCost:          cost,
			MAPPrice:          mapPrice,
			Tags:              tags,
			ChangesInWindow:   changesInWindow,
			LastPriceChangeAt: lastChange,
		},
		Proposal: enforcer.Proposal{
			SKUID:         name,
			ProposedPrice: proposed,
			ConfidenceBP:  confidence,
			Rationale:     rationale,
		},
	}
}
