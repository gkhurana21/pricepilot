package main

import (
	"fmt"

	"github.com/gkhurana21/pricepilot/pricing"
)

// writtenFor is the sha256 of the .xlsx the "What this shows" text was
// written against, after the first full run. On any other file the text is
// withheld, because its wording describes results that file may not
// reproduce. The figures inside it are computed, not typed.
const writtenFor = "bcbe73b35f5b7babf197fb0cb983a11f5d9ff929078d4aa53d171b1f2df2e980"

func whatThisShows(sum string, fOn, fOff funnel, cf confounding, fF correctedFunnels) []string {
	if sum != writtenFor {
		return []string{"(withheld: this text was written for the .xlsx with sha256 " + writtenFor + ", not this one)"}
	}
	compared := cf.splitEligible - cf.splitEmpty
	shifted := 0
	for _, d := range cf.diffOff {
		if d > 0 {
			shifted++
		}
	}
	return []string{
		fmt.Sprintf("As shipped, the estimator answers for %d of %d products (%.1f%%), which sold %.1f%% of units; the volume gate alone refuses %d (%.1f%%).",
			fOn.Usable, fOn.Products, pct(fOn.Usable, fOn.Products), pct(fOn.UsableU, fOn.TotalUnits),
			fOn.Refused[pricing.RefusalVolumeTooLow], pct(fOn.Refused[pricing.RefusalVolumeTooLow], fOn.Products)),
		fmt.Sprintf("Without the gate it would answer for %d (%.1f%%), %.1f%% below -1; %d of those sell under the %g-a-day floor that cmd/sweep set on synthetic data.",
			fOff.Usable, pct(fOff.Usable, fOff.Products), pct(fOff.BelowMinus, fOff.Usable),
			fOff.Usable-fOn.Usable, pricing.DefaultFitOptions().MinMeanUnitsPerDay),
		fmt.Sprintf("Larger lines paid less per unit in %d of %d products with %d+ lines (median price ratio %.2f), and %.1f%% of units sold on product-days with more than one price.",
			cf.splitLower, compared, minLinesForSplit, cf.medianRatio, pct(cf.multiUnits, cf.units)),
		"So a day's price and a day's units can both move with who ordered that day, and the model has no control for it.",
		fmt.Sprintf("Refitting the %d usable products on retail-sized lines leaves %d usable with the gate on; with it off, %d of %d move toward zero (median %+.2f).",
			cf.retailN, cf.retailUsableOn, shifted, len(cf.diffOff), quantile(cf.diffOff, 0.5)),
		"These estimates are consistent with order-size confounding; this run cannot say how much of any estimate it explains, or that any estimate is right.",
		fmt.Sprintf("Netting out cancelled orders (section F, a rule added after the first run) takes the gate-on usable count from %d to %d.",
			fOn.Usable, fF.on.Usable),
	}
}
