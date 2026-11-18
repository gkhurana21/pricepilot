package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func runPlan(t *testing.T, args ...string) (string, string, int) {
	t.Helper()
	var so, se bytes.Buffer
	code := run(args, &so, &se)
	return so.String(), se.String(), code
}

func TestPlanIsDeterministic(t *testing.T) {
	a, _, ca := runPlan(t, "-end", "2026-11-18")
	b, _, cb := runPlan(t, "-end", "2026-11-18")
	if ca != 0 || cb != 0 {
		t.Fatalf("exit codes %d, %d", ca, cb)
	}
	if a != b {
		t.Fatal("two runs with the same -end are not byte-identical")
	}
	c, _, _ := runPlan(t, "-end", "2026-11-19")
	if a == c {
		t.Fatal("a different -end produced the same plan")
	}
}

func TestCheckPasses(t *testing.T) {
	out, errs, code := runPlan(t, "-end", "2026-11-18", "-check")
	if code != 0 {
		t.Fatalf("-check exit %d\n%s\n%s", code, out, errs)
	}
	if !strings.Contains(out, "CHECK PASSED") {
		t.Fatalf("no CHECK PASSED in output:\n%s", out)
	}
}

func TestPlanShape(t *testing.T) {
	out, _, _ := runPlan(t, "-end", "2026-11-18")
	var p Plan
	if err := json.Unmarshal([]byte(out), &p); err != nil {
		t.Fatal(err)
	}
	if !p.Synthetic || !strings.Contains(p.Label, "SYNTHETIC") {
		t.Error("plan must be labelled synthetic")
	}
	if p.History.Start != "2026-08-20" || p.History.End != "2026-11-17" || len(p.History.Dates) != 90 {
		t.Errorf("history window wrong: %+v", p.History)
	}
	noCost := 0
	for _, pr := range p.Products {
		if len(pr.Prices) != 90 || len(pr.Units) != 90 {
			t.Errorf("%s: series length %d/%d", pr.Handle, len(pr.Prices), len(pr.Units))
		}
		if pr.Prices[89] != pr.PriceCents {
			t.Errorf("%s: price_cents %d is not the last day's price %d", pr.Handle, pr.PriceCents, pr.Prices[89])
		}
		if pr.UnitCostCents == nil {
			noCost++
		}
	}
	if noCost != 1 {
		t.Errorf("want exactly one product without a unit cost, got %d", noCost)
	}
	if len(p.Expected.Products) != len(p.Products) {
		t.Error("expected must cover every product")
	}
}

func TestCheckRejectsAWeakPlan(t *testing.T) {
	out, _, _ := runPlan(t, "-end", "2026-11-18")
	var p Plan
	if err := json.Unmarshal([]byte(out), &p); err != nil {
		t.Fatal(err)
	}
	if len(Check(p)) != 0 {
		t.Fatal("baseline plan should pass")
	}
	for i := range p.Expected.Products {
		if p.Expected.Products[i].DecidingRule == "excluded" {
			p.Expected.Products[i].DecidingRule = "min_change"
		}
	}
	if len(Check(p)) == 0 {
		t.Fatal("a plan with no excluded reject must fail the check")
	}
}
