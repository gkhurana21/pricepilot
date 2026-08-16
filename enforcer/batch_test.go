package enforcer

import (
	"fmt"
	"testing"
)

func batchItems(n int, confidences []BasisPoints) []Item {
	items := make([]Item, n)
	for i := 0; i < n; i++ {
		conf := BasisPoints(9000)
		if i < len(confidences) {
			conf = confidences[i]
		}
		items[i] = Item{
			SKU: SKUState{
				ID:           fmt.Sprintf("sku_%02d", i),
				CurrentPrice: 2000,
				UnitCost:     800,
			},
			Proposal: Proposal{
				SKUID:         fmt.Sprintf("sku_%02d", i),
				ProposedPrice: 1900,
				ConfidenceBP:  conf,
			},
		}
	}
	return items
}

// The change budget is the one guardrail that cannot be evaluated per-SKU. A
// merchant setting it is protecting against a systemic estimator failure, not a
// single bad price, so it has to be decided across the whole run.
func TestChangeBudgetCapsARun(t *testing.T) {
	pol := basePolicy()
	pol.MaxSKUsChangedBP = 3000 // move at most 30% of the run

	res := DecideBatch(Request{Policy: pol, Now: testNow, Items: batchItems(10, nil)})

	changed := res.Summary.Approved + res.Summary.Clamped
	if changed != 3 {
		t.Fatalf("budget allowed %d changes, want 3 of 10", changed)
	}
	if res.Summary.RejectedByRule[RuleBatchBudget] != 7 {
		t.Fatalf("expected 7 SKUs held back by the budget, got %d",
			res.Summary.RejectedByRule[RuleBatchBudget])
	}
}

// Which changes survive the budget must be decided the same way every time,
// or a merchant re-running the same review sees a different set and stops
// trusting the preview.
func TestChangeBudgetSelectsHighestConfidenceDeterministically(t *testing.T) {
	pol := basePolicy()
	pol.MaxSKUsChangedBP = 3000

	confidences := []BasisPoints{1000, 9500, 3000, 9500, 8000, 2000, 500, 100, 7000, 6000}
	items := batchItems(10, confidences)

	first := DecideBatch(Request{Policy: pol, Now: testNow, Items: items})

	var survived []string
	for _, d := range first.Decisions {
		if d.Action != ActionReject {
			survived = append(survived, d.SKUID)
		}
	}

	// 9500 ties between sku_01 and sku_03; the id breaks it, so both are kept
	// ahead of the 8000 at sku_04.
	want := []string{"sku_01", "sku_03", "sku_04"}
	if len(survived) != len(want) {
		t.Fatalf("survivors = %v, want %v", survived, want)
	}
	for i := range want {
		if survived[i] != want[i] {
			t.Fatalf("survivors = %v, want %v", survived, want)
		}
	}

	for run := 0; run < 20; run++ {
		again := DecideBatch(Request{Policy: pol, Now: testNow, Items: items})
		for i := range again.Decisions {
			if again.Decisions[i].Action != first.Decisions[i].Action ||
				again.Decisions[i].FinalPrice != first.Decisions[i].FinalPrice {
				t.Fatalf("run %d diverged at %s", run, again.Decisions[i].SKUID)
			}
		}
	}
}

func TestSummaryCountsEveryDecision(t *testing.T) {
	pol := basePolicy()
	pol.MarginFloor = MarginFloor{Basis: MarginOnPrice, Rate: 4000}

	items := []Item{
		{SKU: SKUState{ID: "a", CurrentPrice: 2000, UnitCost: 800}, Proposal: Proposal{SKUID: "a", ProposedPrice: 1900, ConfidenceBP: 9000}},
		{SKU: SKUState{ID: "b", CurrentPrice: 2000, UnitCost: 800}, Proposal: Proposal{SKUID: "b", ProposedPrice: 1000, ConfidenceBP: 9000}},
		{SKU: SKUState{ID: "c", CurrentPrice: 2000, UnitCost: 800}, Proposal: Proposal{SKUID: "c", ProposedPrice: 2000, ConfidenceBP: 9000}},
		{SKU: SKUState{ID: "d", CurrentPrice: 2000, UnitCost: 0}, Proposal: Proposal{SKUID: "d", ProposedPrice: 2100, ConfidenceBP: 9000}},
	}

	res := DecideBatch(Request{Policy: pol, Now: testNow, Items: items})
	s := res.Summary

	if s.Total != 4 {
		t.Errorf("total = %d, want 4", s.Total)
	}
	if got := s.Approved + s.Clamped + s.Rejected; got != s.Total {
		t.Errorf("approved+clamped+rejected = %d, want %d", got, s.Total)
	}
	if s.Approved != 1 {
		t.Errorf("approved = %d, want 1 (a: $19.00 clears the $13.33 floor)", s.Approved)
	}
	if s.Clamped != 1 {
		t.Errorf("clamped = %d, want 1 (b: $10.00 raised to the floor)", s.Clamped)
	}
	if s.Rejected != 2 {
		t.Errorf("rejected = %d, want 2 (c: no-op, d: no unit cost)", s.Rejected)
	}
	if s.RejectedByRule[RuleNoChange] != 1 {
		t.Errorf("expected one no-change rejection, got %d", s.RejectedByRule[RuleNoChange])
	}
	if s.RejectedByRule[RuleInvalidInput] != 1 {
		t.Errorf("expected one invalid-input rejection, got %d", s.RejectedByRule[RuleInvalidInput])
	}
}

// The hash is what makes a past run replayable: the audit log stores it, and a
// merchant asking "what were my rules in March?" gets an answer that does not
// depend on anyone having written it down.
func TestPolicyHashTracksMeaningfulChanges(t *testing.T) {
	a := basePolicy()
	b := basePolicy()

	if PolicyHash(a) != PolicyHash(b) {
		t.Fatal("identical policies must hash identically")
	}
	b.MaxDecreaseBP = a.MaxDecreaseBP + 1
	if PolicyHash(a) == PolicyHash(b) {
		t.Fatal("a changed guardrail must change the hash")
	}
}
