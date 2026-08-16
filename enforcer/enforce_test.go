package enforcer

import (
	"testing"
	"time"
)

var testNow = time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)

// basePolicy is a realistic merchant configuration. Each test overrides only
// the rule it is about, so a failure names one guardrail rather than a soup.
func basePolicy() Policy {
	return Policy{
		ID:            "pol_test",
		Version:       1,
		MaxDecreaseBP: 2000, // 20%
		MaxIncreaseBP: 2000,
	}
}

func sku(current, cost Cents) SKUState {
	return SKUState{ID: "sku_1", CurrentPrice: current, UnitCost: cost}
}

func propose(price Cents) Proposal {
	return Proposal{SKUID: "sku_1", ProposedPrice: price, ConfidenceBP: 9000}
}

func TestDecide(t *testing.T) {
	tests := []struct {
		name       string
		policy     func(Policy) Policy
		state      SKUState
		proposal   Proposal
		wantAction Action
		wantPrice  Cents
		wantRule   RuleID // a rule that must appear in the reasons
		why        string
	}{
		{
			name:       "compliant proposal passes through untouched",
			policy:     func(p Policy) Policy { p.Rounding = RoundCharm99; return p },
			state:      sku(1000, 400),
			proposal:   propose(899),
			wantAction: ActionApprove,
			wantPrice:  899,
			why:        "already inside every bound and already ends in .99",
		},
		{
			name: "gross margin floor raises a too-deep markdown",
			policy: func(p Policy) Policy {
				p.MarginFloor = MarginFloor{Basis: MarginOnPrice, Rate: 4000}
				return p
			},
			state:      sku(1200, 600),
			proposal:   propose(900),
			wantAction: ActionClamp,
			wantPrice:  1000, // 600 / (1 - 0.40)
			wantRule:   RuleMarginFloor,
			why:        "40% gross margin on a $6.00 cost requires $10.00",
		},
		{
			name: "markup basis is not the same rule as gross margin",
			policy: func(p Policy) Policy {
				p.MarginFloor = MarginFloor{Basis: MarginOnCost, Rate: 4000}
				p.MaxDecreaseBP = 5000
				return p
			},
			state:      sku(2000, 1000),
			proposal:   propose(1200),
			wantAction: ActionClamp,
			wantPrice:  1400, // 1000 * 1.40, not 1000/0.60 = 1667
			wantRule:   RuleMarginFloor,
			why:        "conflating markup with margin is the classic retail pricing bug",
		},
		{
			name: "margin floor with no unit cost fails closed",
			policy: func(p Policy) Policy {
				p.MarginFloor = MarginFloor{Basis: MarginOnPrice, Rate: 4000}
				return p
			},
			state:      sku(1200, 0),
			proposal:   propose(1100),
			wantAction: ActionReject,
			wantRule:   RuleInvalidInput,
			why:        "an unenforceable floor must block, never silently pass",
		},
		{
			name:       "MAP holds the line under a competitive markdown",
			policy:     func(p Policy) Policy { p.RespectMAP = true; p.MaxDecreaseBP = 4000; return p },
			state:      SKUState{ID: "sku_1", CurrentPrice: 2500, UnitCost: 900, MAPPrice: 2000},
			proposal:   propose(1800),
			wantAction: ActionClamp,
			wantPrice:  2000,
			wantRule:   RuleMAP,
			why:        "advertising below MAP risks the supplier relationship, not just margin",
		},
		{
			name:       "per-cycle decrease cap limits how fast a price can fall",
			policy:     func(p Policy) Policy { p.MaxDecreaseBP = 1000; return p },
			state:      sku(1000, 200),
			proposal:   propose(700),
			wantAction: ActionClamp,
			wantPrice:  900,
			wantRule:   RuleMaxDecrease,
			why:        "a merchant delegates the direction, not the magnitude",
		},
		{
			name:       "per-cycle increase cap limits how fast a price can rise",
			policy:     func(p Policy) Policy { p.MaxIncreaseBP = 500; return p },
			state:      sku(1000, 200),
			proposal:   propose(1400),
			wantAction: ActionClamp,
			wantPrice:  1050,
			wantRule:   RuleMaxIncrease,
			why:        "customers notice a 40% jump; they rarely notice 5%",
		},
		{
			name: "rounding may not undo the margin floor",
			policy: func(p Policy) Policy {
				p.MarginFloor = MarginFloor{Basis: MarginOnPrice, Rate: 4000}
				p.Rounding = RoundCharm99
				return p
			},
			state:      sku(1200, 600),
			proposal:   propose(1002),
			wantAction: ActionClamp,
			wantPrice:  1099,
			wantRule:   RuleRounding,
			why:        "naive .99 rounding gives $9.99 and quietly breaches the $10.00 floor",
		},
		{
			name: "an exact price beats a pretty one when no ending fits",
			policy: func(p Policy) Policy {
				p.MarginFloor = MarginFloor{Basis: MarginOnPrice, Rate: 4000}
				p.HardCeiling = 1002
				p.MaxIncreaseBP = 2000
				p.Rounding = RoundCharm99
				return p
			},
			state:      sku(1200, 600),
			proposal:   propose(1001),
			wantAction: ActionApprove,
			wantPrice:  1001,
			wantRule:   RuleRounding,
			why:        "no .99 price exists in [$10.00, $10.02], so rounding stands down",
		},
		{
			name: "contradictory guardrails are reported, not silently resolved",
			policy: func(p Policy) Policy {
				p.MarginFloor = MarginFloor{Basis: MarginOnPrice, Rate: 5000}
				p.MaxIncreaseBP = 1000
				return p
			},
			state:      sku(1000, 1500),
			proposal:   propose(3000),
			wantAction: ActionReject,
			wantRule:   RuleInfeasible,
			why:        "the floor needs $30.00 but a 10% cap only reaches $11.00; the merchant must decide",
		},
		{
			name:       "a SKU repriced too recently is left alone",
			policy:     func(p Policy) Policy { p.Velocity = Velocity{MinDaysBetweenChanges: 14}; return p },
			state:      SKUState{ID: "sku_1", CurrentPrice: 1000, UnitCost: 200, LastPriceChangeAt: testNow.AddDate(0, 0, -3)},
			proposal:   propose(950),
			wantAction: ActionReject,
			wantRule:   RuleVelocityDays,
			why:        "price churn erodes trust faster than a suboptimal price erodes margin",
		},
		{
			name:       "a SKU at its change limit for the window is left alone",
			policy:     func(p Policy) Policy { p.Velocity = Velocity{MaxChangesPerWindow: 2, WindowDays: 30}; return p },
			state:      SKUState{ID: "sku_1", CurrentPrice: 1000, UnitCost: 200, ChangesInWindow: 2},
			proposal:   propose(950),
			wantAction: ActionReject,
			wantRule:   RuleVelocityCount,
			why:        "",
		},
		{
			name:       "an excluded tag beats every other signal",
			policy:     func(p Policy) Policy { p.Exclusions = Exclusions{Tags: []string{"do-not-reprice"}}; return p },
			state:      SKUState{ID: "sku_1", CurrentPrice: 1000, UnitCost: 200, Tags: []string{"sale", "do-not-reprice"}},
			proposal:   propose(950),
			wantAction: ActionReject,
			wantRule:   RuleExcluded,
			why:        "exclusion is the merchant's override and nothing outranks it",
		},
		{
			name:       "a low-confidence estimate proposes nothing at all",
			policy:     func(p Policy) Policy { p.MinConfidenceBP = 7000; return p },
			state:      sku(1000, 200),
			proposal:   Proposal{SKUID: "sku_1", ProposedPrice: 950, ConfidenceBP: 3000},
			wantAction: ActionReject,
			wantRule:   RuleConfidence,
			why:        "declining to answer is more useful than a confident wrong number",
		},
		{
			name:       "a no-op does not consume an API call or a velocity slot",
			policy:     func(p Policy) Policy { return p },
			state:      sku(1000, 200),
			proposal:   propose(1000),
			wantAction: ActionReject,
			wantRule:   RuleNoChange,
			why:        "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			pol := tc.policy(basePolicy())
			got := Decide(pol, tc.state, tc.proposal, testNow)

			checkInvariants(t, pol, tc.state, tc.proposal, testNow, got)

			if got.Action != tc.wantAction {
				t.Errorf("action = %q, want %q\nreasons: %s", got.Action, tc.wantAction, formatReasons(got))
			}
			if tc.wantAction != ActionReject && got.FinalPrice != tc.wantPrice {
				t.Errorf("final price = %s, want %s\nreasons: %s", got.FinalPrice, tc.wantPrice, formatReasons(got))
			}
			if tc.wantRule != "" && !hasRule(got, tc.wantRule) {
				t.Errorf("expected rule %q in reasons, got: %s", tc.wantRule, formatReasons(got))
			}
			if tc.why != "" {
				t.Logf("%s", tc.why)
			}
		})
	}
}

func hasRule(d Decision, r RuleID) bool {
	for _, reason := range d.Reasons {
		if reason.Rule == r {
			return true
		}
	}
	return false
}

func formatReasons(d Decision) string {
	if len(d.Reasons) == 0 {
		return "(none)"
	}
	out := ""
	for _, r := range d.Reasons {
		out += "\n  - [" + string(r.Rule) + "/" + string(r.Effect) + "] " + r.Message
	}
	return out
}
