package main

import (
	"math"
	"strings"
	"testing"

	"github.com/gkhurana21/pricepilot/pricing"
)

func TestQuantileType7(t *testing.T) {
	v := []float64{1, 2, 3, 4}
	for p, want := range map[float64]float64{0: 1, 0.25: 1.75, 0.5: 2.5, 0.75: 3.25, 1: 4} {
		if got := quantile(v, p); math.Abs(got-want) > 1e-12 {
			t.Errorf("quantile(%v) = %v, want %v", p, got, want)
		}
	}
	if !math.IsNaN(quantile(nil, 0.5)) {
		t.Error("quantile of nothing should be NaN")
	}
}

func TestFunnelCountsEveryProductOnce(t *testing.T) {
	ests := []pricing.Estimate{
		{Method: pricing.MethodOLS, Elasticity: -2},
		{Method: pricing.MethodOLS, Elasticity: -0.5},
		{Method: pricing.MethodRefused, Refusal: pricing.RefusalTooFewDays},
		{Method: pricing.MethodRefused, Refusal: pricing.RefusalVolumeTooLow},
		{Method: pricing.MethodRefused, Refusal: pricing.RefusalVolumeTooLow},
	}
	f := makeFunnel(ests, []int{100, 50, 5, 20, 25})
	if f.Products != 5 || f.Usable != 2 || f.UsableU != 150 || f.BelowMinus != 1 || f.TotalUnits != 200 ||
		f.Refused[pricing.RefusalVolumeTooLow] != 2 || f.RefusedU[pricing.RefusalVolumeTooLow] != 45 {
		t.Errorf("funnel = %+v", f)
	}
	var b strings.Builder
	writeFunnel(&b, f) // panics if the stages do not add up
	if !strings.Contains(b.String(), "USABLE") {
		t.Error("funnel output has no USABLE row")
	}
}

func TestConfoundingMeasures(t *testing.T) {
	ls := []line{
		{Product: "A", Day: 1, Qty: 1, Pence: 300},
		{Product: "A", Day: 1, Qty: 2, Pence: 300},
		{Product: "A", Day: 1, Qty: 48, Pence: 200}, // same day, second price
		{Product: "A", Day: 2, Qty: 96, Pence: 180},
		{Product: "B", Day: 2, Qty: 6, Pence: 100},
	}
	pairs, multi, units, multiUnits := multiPriceDays(ls)
	if pairs != 3 || multi != 1 || units != 153 || multiUnits != 51 {
		t.Errorf("multiPriceDays = %d %d %d %d", pairs, multi, units, multiUnits)
	}

	a := ls[:4] // quantities 1, 2, 48, 96: lower median 2
	large, small, ok := sizeSplit(a)
	wantLarge := (2*300.0 + 48*200 + 96*180) / (2 + 48 + 96)
	if !ok || math.Abs(large-wantLarge) > 1e-9 || small != 300 {
		t.Errorf("sizeSplit = %v %v %v, want %v 300", large, small, ok, wantLarge)
	}
	if _, _, ok := sizeSplit([]line{{Qty: 5}, {Qty: 5}}); ok {
		t.Error("equal quantities leave no small group, so the split must report not ok")
	}
	if got := retailLines(a); len(got) != 2 || got[0].Qty != 1 || got[1].Qty != 2 {
		t.Errorf("retailLines = %+v", got)
	}
}

func TestWhatThisShowsIsWithheldForAnotherFile(t *testing.T) {
	got := whatThisShows("not-the-file", funnel{}, funnel{}, confounding{}, correctedFunnels{})
	if len(got) != 1 || !strings.Contains(got[0], "withheld") {
		t.Errorf("got %q", got)
	}
}

func TestSameDaySplitLooksOnlyInsideOneProductDay(t *testing.T) {
	lines := []line{
		// product A, day 1: the cheap price carries the big lines
		{Product: "A", Day: 1, Qty: 48, Pence: 100},
		{Product: "A", Day: 1, Qty: 2, Pence: 150},
		{Product: "A", Day: 1, Qty: 1, Pence: 150},
		// product A, day 2: one price only, not counted
		{Product: "A", Day: 2, Qty: 500, Pence: 90},
		// product B, day 1: the cheap price carries the small line
		{Product: "B", Day: 1, Qty: 1, Pence: 200},
		{Product: "B", Day: 1, Qty: 10, Pence: 250},
		// product C, day 3: same mean quantity at both prices
		{Product: "C", Day: 3, Qty: 4, Pence: 300},
		{Product: "C", Day: 3, Qty: 4, Pence: 320},
	}
	days, larger, equal := sameDaySplit(lines)
	if days != 3 || larger != 1 || equal != 1 {
		t.Fatalf("days %d larger %d equal %d, want 3, 1, 1", days, larger, equal)
	}
}
