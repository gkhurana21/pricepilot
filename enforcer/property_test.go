package enforcer

import (
	"math/rand"
	"testing"
)

// TestInvariantsUnderRandomInput runs the same checks as the fuzzer over a
// fixed, seeded sample. The fuzzer explores deeply but only when someone runs
// it with -fuzz; this runs on every `go test`, so a regression cannot reach
// main just because nobody launched the fuzzer that week.
func TestInvariantsUnderRandomInput(t *testing.T) {
	const cases = 200_000
	rng := rand.New(rand.NewSource(20260816))
	buf := make([]byte, 96)

	var approved, clamped, rejected, belowFloor, belowFloorInfeasible int
	for i := 0; i < cases; i++ {
		rng.Read(buf)
		pol, state, prop, now := decodeScenario(buf)
		d := Decide(pol, state, prop, now)
		checkInvariants(t, pol, state, prop, now, d)

		if pol.ID == belowFloorID {
			belowFloor++
			if hasRule(d, RuleInfeasible) {
				belowFloorInfeasible++
			}
		}

		switch d.Action {
		case ActionApprove:
			approved++
		case ActionClamp:
			clamped++
		case ActionReject:
			rejected++
		}
	}

	t.Logf("%d scenarios: %d approved, %d clamped, %d rejected; %d started below a lower bound (%d of them infeasible)",
		cases, approved, clamped, rejected, belowFloor, belowFloorInfeasible)

	// A sample that never produces a price would pass every invariant while
	// testing nothing. Guard against the test silently going hollow.
	if approved+clamped == 0 {
		t.Fatal("no scenario produced a price; the generator is not exercising the engine")
	}
	if rejected == 0 {
		t.Fatal("no scenario was rejected; the generator is not exercising the guardrails")
	}
	if belowFloor == 0 || belowFloorInfeasible == 0 {
		t.Fatalf("below-floor scenarios: %d generated, %d infeasible; the generator never reaches a current price below its floor",
			belowFloor, belowFloorInfeasible)
	}
}

// TestDecisionIsAFixedPoint asserts that re-running the engine on its own output
// proposes nothing further.
//
// This matters operationally: a scheduled repricer that keeps nudging the same
// SKU every cycle burns the merchant's velocity budget and trains customers to
// wait for the next drop. The output price must be stable under the policy that
// produced it.
func TestDecisionIsAFixedPoint(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	buf := make([]byte, 96)
	checked := 0

	for i := 0; i < 50_000; i++ {
		rng.Read(buf)
		pol, state, prop, now := decodeScenario(buf)

		// Rounding and velocity are deliberately excluded. Velocity is a
		// function of history, not price, and a rounding rule can legitimately
		// find a newly-reachable ending once the interval shifts — neither is
		// a stability defect.
		pol.Rounding = RoundNone
		pol.Velocity = Velocity{}

		first := Decide(pol, state, prop, now)
		if first.Action == ActionReject {
			continue
		}

		settled := state
		settled.CurrentPrice = first.FinalPrice
		second := Decide(pol, settled, Proposal{
			SKUID:         prop.SKUID,
			ProposedPrice: first.FinalPrice,
			ConfidenceBP:  prop.ConfidenceBP,
		}, now)

		if second.Action != ActionReject || !hasRule(second, RuleNoChange) {
			t.Fatalf("price %s was not stable: re-deciding gave %q -> %s%s",
				first.FinalPrice, second.Action, second.FinalPrice, formatReasons(second))
		}
		checked++
	}

	if checked == 0 {
		t.Fatal("no scenario produced a price to re-decide")
	}
	t.Logf("%d settled prices re-decided to no-change", checked)
}

// TestRaisingTheMarginFloorNeverLowersThePrice checks the engine responds to a
// stricter policy in the direction a merchant expects. A guardrail that
// sometimes produces a *worse* outcome when tightened is one merchants stop
// trusting, even if every individual decision is technically compliant.
func TestRaisingTheMarginFloorNeverLowersThePrice(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	buf := make([]byte, 96)
	compared := 0

	for i := 0; i < 50_000; i++ {
		rng.Read(buf)
		pol, state, prop, now := decodeScenario(buf)

		// Rounding is excluded here on purpose: snapping to a fixed ending is a
		// step function, so it can move a price down when the interval shifts
		// up. That is the rounding rule behaving correctly, not a monotonicity
		// break, and folding it in would test two things at once.
		pol.Rounding = RoundNone
		pol.MarginFloor.Basis = MarginOnPrice
		pol.MarginFloor.Rate = 2000

		loose := Decide(pol, state, prop, now)

		strict := pol
		strict.MarginFloor.Rate = 4000
		tight := Decide(strict, state, prop, now)

		if loose.Action == ActionReject || tight.Action == ActionReject {
			continue
		}
		if tight.FinalPrice < loose.FinalPrice {
			t.Fatalf("raising the margin floor lowered the price: %s at 20%% became %s at 40%% (cost %s)",
				loose.FinalPrice, tight.FinalPrice, state.UnitCost)
		}
		compared++
	}

	if compared == 0 {
		t.Fatal("no scenario produced a price under both policies")
	}
	t.Logf("%d policy pairs compared", compared)
}

// TestMarginFloorArithmetic pins the two margin definitions against
// hand-computed values. The fuzzer proves the floor is never breached; this
// proves the floor is in the right place to begin with.
func TestMarginFloorArithmetic(t *testing.T) {
	tests := []struct {
		basis MarginBasis
		rate  BasisPoints
		cost  Cents
		want  Cents
		why   string
	}{
		{MarginOnPrice, 4000, 1000, 1667, "$10.00 cost at 40% gross margin needs $16.67"},
		{MarginOnCost, 4000, 1000, 1400, "the same numbers as markup need only $14.00"},
		{MarginOnPrice, 5000, 999, 1998, "50% margin doubles the cost"},
		{MarginOnPrice, 0, 1000, 0, "an inactive rate imposes no floor"},
		{MarginOnPrice, 3333, 1, 2, "a sub-cent floor rounds up, never down"},
		{MarginOnCost, 10000, 500, 1000, "100% markup doubles the cost"},
	}

	for _, tc := range tests {
		got, err := marginFloorPrice(MarginFloor{Basis: tc.basis, Rate: tc.rate}, tc.cost)
		if err != nil {
			t.Errorf("%s: unexpected error %v", tc.why, err)
			continue
		}
		if got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.why, got, tc.want)
		}
	}
}
