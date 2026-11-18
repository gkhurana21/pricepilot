package enforcer

import (
	"strings"
	"testing"
)

// directionRule is spelled as a literal here on purpose: it is the wire value
// the UI and audit log see, so a test that went through the Go constant could
// not notice the constant being renamed.
const directionRule = RuleID("proposal_direction")

// TestProposalDirectionIsABound pins what happens when rounding or a bound
// would otherwise move a price the opposite way from the proposal. A proposal
// to cut a price must never end up raising it, and vice versa.
func TestProposalDirectionIsABound(t *testing.T) {
	// The demo policy: 40% gross margin floor, .99 endings.
	demo := func(p Policy) Policy {
		p.MarginFloor = MarginFloor{Basis: MarginOnPrice, Rate: 4000}
		p.MaxDecreaseBP = 1500
		p.MaxIncreaseBP = 1000
		p.Rounding = RoundCharm99
		p.MinChangeBP = 200
		return p
	}

	tests := []struct {
		name       string
		policy     func(Policy) Policy
		state      SKUState
		proposal   Proposal
		wantAction Action
		wantPrice  Cents // checked when the action is not reject
		wantRule   RuleID
		wantInMsg  []string // substrings required in the message of wantRule
		notInMsg   []string // substrings forbidden in every message
	}{
		{
			name:       "Colombia: a cut whose floor is the current price is rejected, not raised to 18.99",
			policy:     demo,
			state:      sku(1800, 1080),
			proposal:   propose(1400),
			wantAction: ActionReject,
			wantRule:   RuleNoChange,
		},
		{
			name: "a cut is not rounded up to a price above the current one",
			policy: func(p Policy) Policy {
				p.MaxDecreaseBP = 1500
				p.MaxIncreaseBP = 2000
				p.Rounding = RoundNearestFive
				return p
			},
			state:      sku(1445, 400),
			proposal:   propose(1329),
			wantAction: ActionApprove,
			wantPrice:  1329,
			wantRule:   RuleRounding, // stood down: no $5 ending lies at or below the current price
		},
		{
			// With a 35% cap the admissible range reaches 10.00, and rounding used
			// to take it: an 8% proposed cut became a 30.8% cut. Rounding may tidy
			// an ending but never go further than the model asked.
			name: "rounding never cuts further than the proposal, however wide the cap",
			policy: func(p Policy) Policy {
				p.MaxDecreaseBP = 3500
				p.MaxIncreaseBP = 2000
				p.Rounding = RoundNearestFive
				return p
			},
			state:      sku(1445, 400),
			proposal:   propose(1329),
			wantAction: ActionApprove,
			wantPrice:  1329,
			wantRule:   RuleRounding, // stood down: no $5 ending lies between the proposal and the current price
		},
		{
			name: "a cut rounds to the ending between the proposal and the current price, not the one past it",
			policy: func(p Policy) Policy {
				p.MaxDecreaseBP = 1500
				p.Rounding = RoundCharm99
				return p
			},
			state:      sku(1900, 880),
			proposal:   propose(1745), // 16.99 is nearer and inside the cap, but it is past what was asked
			wantAction: ActionClamp,
			wantPrice:  1799,
			wantRule:   RuleRounding,
		},
		{
			name: "a rise rounds to the ending between the current price and the proposal, not the one past it",
			policy: func(p Policy) Policy {
				p.MaxIncreaseBP = 2000
				p.Rounding = RoundCharm99
				return p
			},
			state:      sku(2000, 800),
			proposal:   propose(2260), // 22.99 is nearer and inside the cap, but it is past what was asked
			wantAction: ActionClamp,
			wantPrice:  2199,
			wantRule:   RuleRounding,
		},
		{
			name: "a small cut whose only permitted ending is a cent away is too small to apply",
			policy: func(p Policy) Policy {
				p.Rounding = RoundCharm99
				p.MinChangeBP = 200
				return p
			},
			state:      sku(1800, 800),
			proposal:   propose(1740), // used to become 16.99, a 5.6% cut on a 3.3% proposal
			wantAction: ActionReject,
			wantRule:   RuleMinChange,
		},
		{
			name:       "a cut on a SKU already below its margin floor is infeasible, not clamped up",
			policy:     demo,
			state:      sku(1500, 1080), // floor is 18.00
			proposal:   propose(1400),
			wantAction: ActionReject,
			wantRule:   RuleInfeasible,
			wantInMsg:  []string{"margin_floor", "current price", "below the floor"},
			notInMsg:   []string{"compliant price equals the current price"},
		},
		{
			name:       "proposal equal to the current price is no change and rounding does not move it",
			policy:     demo,
			state:      sku(2000, 800),
			proposal:   propose(2000),
			wantAction: ActionReject,
			wantRule:   RuleNoChange,
		},
		{
			name:       "proposal equal to the current price below the margin floor names the floor",
			policy:     demo,
			state:      sku(1500, 1080),
			proposal:   propose(1500),
			wantAction: ActionReject,
			wantRule:   RuleInfeasible,
			wantInMsg:  []string{"margin_floor", "below the floor"},
			notInMsg:   []string{"compliant price equals the current price"},
		},
		{
			name:       "a rise on a SKU above its catalog ceiling is infeasible, not clamped down",
			policy:     func(p Policy) Policy { p.HardCeiling = 900; return p },
			state:      sku(1000, 200),
			proposal:   propose(1100),
			wantAction: ActionReject,
			wantRule:   RuleInfeasible,
			wantInMsg:  []string{"hard_ceiling", "above the ceiling"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			pol := tc.policy(basePolicy())
			got := Decide(pol, tc.state, tc.proposal, testNow)
			checkInvariants(t, pol, tc.state, tc.proposal, testNow, got)

			if got.Action != tc.wantAction {
				t.Errorf("action = %q, want %q (final %s)\nreasons: %s",
					got.Action, tc.wantAction, got.FinalPrice, formatReasons(got))
			}
			if tc.wantAction != ActionReject && got.FinalPrice != tc.wantPrice {
				t.Errorf("final price = %s, want %s\nreasons: %s", got.FinalPrice, tc.wantPrice, formatReasons(got))
			}
			if !hasRule(got, tc.wantRule) {
				t.Errorf("expected rule %q in reasons, got: %s", tc.wantRule, formatReasons(got))
			}
			for _, r := range got.Reasons {
				if r.Rule == tc.wantRule {
					for _, s := range tc.wantInMsg {
						if !strings.Contains(r.Message, s) {
							t.Errorf("message %q does not contain %q", r.Message, s)
						}
					}
				}
				for _, s := range tc.notInMsg {
					if strings.Contains(r.Message, s) {
						t.Errorf("message %q must not contain %q", r.Message, s)
					}
				}
			}
		})
	}
}

// TestDirectionRuleNeverBlamedOnNoChange checks the attribution the plan
// asked for: a direction bound is reported under its own rule id, so no
// message says no_change sets a ceiling or a floor.
func TestDirectionRuleNeverBlamedOnNoChange(t *testing.T) {
	pol := basePolicy()
	pol.MaxDecreaseBP = 1500
	pol.Rounding = RoundNearestFive
	got := Decide(pol, sku(1445, 400), propose(1329), testNow)
	if !hasRule(got, directionRule) {
		t.Fatalf("a cut should record the %q bound, got: %s", directionRule, formatReasons(got))
	}
	for _, r := range got.Reasons {
		if r.Rule == RuleNoChange && r.Effect != EffectInfo {
			t.Errorf("no_change must only ever be informational, got %s: %s", r.Effect, r.Message)
		}
	}
	if got.UpperBound != 1445 {
		t.Errorf("a cut's upper bound = %s, want the current price 14.45", got.UpperBound)
	}
}
