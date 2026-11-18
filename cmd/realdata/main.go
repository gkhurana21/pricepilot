// Command realdata runs the elasticity estimator on a real public retail
// dataset, UCI Online Retail II, and reports what it does: how many products
// it refuses and why, what it answers for the rest, and evidence that the
// answers are confounded by order size. It is a test of the estimator's
// funnel only. The data has no unit cost, so nothing is proposed or enforced.
//
// The cleaning and aggregation rules are fixed in this file and printed at the
// top of the output. They were written before any estimate was computed and
// are not adjusted to improve the result.
//
// There is no ground truth in real sales data. Nothing this command prints can
// show that an estimate is right.
//
//	curl -sSL -o data/online+retail+ii.zip https://archive.ics.uci.edu/static/public/502/online+retail+ii.zip
//	unzip -o data/online+retail+ii.zip -d data
//	go run ./cmd/realdata -file data/online_retail_II.xlsx -out pricing/testdata/realdata_online_retail_ii.txt
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/gkhurana21/pricepilot/pricing"
)

const (
	datasetName = "UCI Online Retail II"
	datasetURL  = "https://archive.ics.uci.edu/dataset/502/online+retail+ii"
	downloadURL = "https://archive.ics.uci.edu/static/public/502/online+retail+ii.zip"
	licence     = "CC BY 4.0"

	topN             = 15
	maxUsableRows    = 40
	minLinesForSplit = 200
	descWidth        = 30
)

// rules is printed verbatim at the top of the output. Fixed before any
// estimate was computed; see the package comment.
var rules = []string{
	"Each line is counted under the first rule that drops it, in this order:",
	"R0  a line in sheet \"Year 2010-2011\" is dropped when sheet \"Year 2009-2010\" holds the same Invoice and an",
	"    identical line (the sheets overlap on 2010-12-01..2010-12-09); a line under a repeated Invoice number",
	"    that the first sheet never held is kept (tightened after review: it first matched on Invoice alone)",
	"R1  malformed: missing or unparseable Invoice, StockCode, Quantity, InvoiceDate or Price, or non-integer Quantity",
	"R2  cancellation: Invoice starts with \"C\"",
	"R3  Quantity <= 0",
	"R4  Price <= 0, or Price that rounds to 0 pence",
	"R5  non-product: StockCode (upper-cased, trimmed) does not start with a digit (POST, DOT, M, BANK CHARGES, ...)",
	"A product is a StockCode, upper-cased and trimmed. Price in pence = round(Price*100).",
	"Day = calendar date of InvoiceDate as recorded, no time-zone shift; Observation.Day = days since 2009-12-01.",
	"A store-open day is a calendar day with at least one kept line for any product; closed days give no observation.",
	"Per product, one observation per store-open day from its first to its last sale day:",
	"  units = sum of quantity that day; price = the price with the most units that day, ties to the lower price;",
	"  an open day without a sale is Units 0 at the most recent price; OnPromo false (the data has no promotion flag).",
	"Estimator: pricing.DefaultFitOptions() as shipped (volume gate on), no pooling. Gate-off run: MinMeanUnitsPerDay = 0.",
	"No unit cost is known, so no price is proposed and the enforcer is not run.",
	"Customer ID and Country are not used in sections A-D.",
}

func main() {
	file := flag.String("file", "", "path to online_retail_II.xlsx (required)")
	out := flag.String("out", "", "also write the report to this file")
	flag.Parse()
	if *file == "" {
		fmt.Fprintln(os.Stderr, "usage: go run ./cmd/realdata -file data/online_retail_II.xlsx [-out report.txt]")
		os.Exit(2)
	}
	start := time.Now()

	sum, err := sha256File(*file)
	if err != nil {
		fail(err)
	}
	wb, err := openWorkbookFile(*file)
	if err != nil {
		fail(err)
	}
	c, err := load(wb)
	wb.Close()
	if err != nil {
		fail(err)
	}

	var buf bytes.Buffer
	// A fixed line, not the arguments actually passed, so the report is
	// byte-identical however the output path is spelled.
	command := "go run ./cmd/realdata -file data/online_retail_II.xlsx"
	report(&buf, command, sum, wb.sheets, c)

	os.Stdout.Write(buf.Bytes())
	if *out != "" {
		if err := os.WriteFile(*out, buf.Bytes(), 0o644); err != nil {
			fail(err)
		}
	}
	fmt.Fprintf(os.Stderr, "realdata: finished in %s\n", time.Since(start).Round(100*time.Millisecond))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "realdata:", err)
	os.Exit(1)
}

func sha256File(name string) (string, error) {
	f, err := os.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func pct(n, d int) float64 {
	if d == 0 {
		return math.NaN()
	}
	return 100 * float64(n) / float64(d)
}

func dayDate(d int) string { return epoch.AddDate(0, 0, d).Format("2006-01-02") }

func cut(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func fmtEst(e pricing.Estimate) string {
	if e.Usable() {
		return fmt.Sprintf("%.2f [%.2f, %.2f]", e.Elasticity, e.CILow, e.CIHigh)
	}
	switch e.Refusal {
	case pricing.RefusalIndistinct, pricing.RefusalWrongSign, pricing.RefusalImprecise:
		return fmt.Sprintf("%s (%+.2f)", e.Refusal, e.Elasticity)
	}
	return string(e.Refusal)
}

func buildProducts(byCode map[string][]line, codes []string, open []int, c *cleaner, onOpt, offOpt pricing.FitOptions) ([]*product, int) {
	prods := make([]*product, len(codes))
	totalUnits := 0
	for i, code := range codes {
		ls := byCode[code]
		p := &product{Code: code, Desc: c.description(code), Lines: ls}
		for _, l := range ls {
			p.Units += l.Qty
		}
		p.Obs = observations(ls, open)
		p.Prices = distinctSalePrices(p.Obs)
		p.On = pricing.EstimateElasticity(code, p.Obs, onOpt)
		p.Off = pricing.EstimateElasticity(code, p.Obs, offOpt)
		prods[i] = p
		totalUnits += p.Units
	}
	return prods, totalUnits
}

func sortByVolume(prods []*product) []*product {
	out := append([]*product(nil), prods...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Units != out[j].Units {
			return out[i].Units > out[j].Units
		}
		return out[i].Code < out[j].Code
	})
	return out
}

func report(w io.Writer, command, sum string, sheets []sheetRef, c *cleaner) {
	open := openDays(c.lines)
	byCode, codes := byProduct(c.lines)

	onOpt := pricing.DefaultFitOptions()
	offOpt := onOpt
	offOpt.MinMeanUnitsPerDay = 0

	prods, totalUnits := buildProducts(byCode, codes, open, c, onOpt, offOpt)

	// ---- header
	fmt.Fprintf(w, "# command: %s\n", command)
	fmt.Fprintf(w, "# go version: %s %s/%s\n", runtime.Version(), runtime.GOOS, runtime.GOARCH)
	fmt.Fprintf(w, "# dataset: %s, %s (download: %s)\n", datasetName, datasetURL, downloadURL)
	fmt.Fprintf(w, "# licence: %s. Only aggregate statistics and a few StockCode/description labels appear below.\n", licence)
	fmt.Fprintf(w, "# sha256 of the .xlsx: %s\n", sum)
	fmt.Fprintf(w, "# no ground truth: real sales data has no known elasticity, so nothing below can show an estimate is right\n")
	fmt.Fprintln(w, "#")
	fmt.Fprintln(w, "# rules (fixed before any estimate was computed):")
	for _, r := range rules {
		fmt.Fprintf(w, "#   %s\n", r)
	}
	fmt.Fprintf(w, "# fit options: MinDays %d, MinDistinctPrices %d, MinLogPriceSD %g, MaxRelativeHalfWidth %g, MinMeanUnitsPerDay %g,\n",
		onOpt.MinDays, onOpt.MinDistinctPrices, onOpt.MinLogPriceSD, onOpt.MaxRelativeHalfWidth, onOpt.MinMeanUnitsPerDay)
	fmt.Fprintf(w, "#   ControlPromo %v, WeeklySeasonality %v, AnnualSeasonality %v, Level %g\n",
		onOpt.ControlPromo, onOpt.WeeklySeasonality, onOpt.AnnualSeasonality, onOpt.Level)
	fmt.Fprintln(w)

	k := c.counts
	fmt.Fprintln(w, "ROWS")
	for i, s := range sheets {
		n := 0
		if i < len(k.ReadBySheet) {
			n = k.ReadBySheet[i]
		}
		fmt.Fprintf(w, "  read from sheet %-24q %9d\n", s.Name, n)
	}
	remaining := k.Read
	fmt.Fprintf(w, "  %-55s %9d\n", "rows read (data rows, all sheets)", remaining)
	step := func(rule string, dropped int) {
		remaining -= dropped
		fmt.Fprintf(w, "  %-40s %9d  -> %9d kept\n", rule, -dropped, remaining)
	}
	step("R0 repeated in the second sheet", k.DupOfEarlier)
	fmt.Fprintf(w, "     (lines under a repeated Invoice number that were not repeats, kept: %d)\n", k.DupInvoiceNew)
	step("R1 malformed", k.Malformed)
	step("R2 cancellation", k.Cancelled)
	step("R3 quantity <= 0", k.QtyNonPositive)
	step("R4 price <= 0", k.PriceNonPos)
	step("R4 price rounds to 0 pence", k.PriceRoundsZero)
	step("R5 non-product StockCode", k.NonProduct)
	if remaining != k.Kept {
		panic(fmt.Sprintf("row accounting: %d remaining, %d kept", remaining, k.Kept))
	}
	fmt.Fprintf(w, "  InvoiceDate range of rows read: %s to %s\n", c.first.Format("2006-01-02 15:04"), c.last.Format("2006-01-02 15:04"))
	if len(open) > 0 {
		span := open[len(open)-1] - open[0] + 1
		fmt.Fprintf(w, "  store-open days: %d of the %d calendar days from %s to %s\n",
			len(open), span, dayDate(open[0]), dayDate(open[len(open)-1]))
	}
	fmt.Fprintf(w, "  products: %d; units sold (kept lines): %d\n", len(prods), totalUnits)
	fmt.Fprintln(w)

	ons := make([]pricing.Estimate, len(prods))
	offs := make([]pricing.Estimate, len(prods))
	units := make([]int, len(prods))
	for i, p := range prods {
		ons[i], offs[i], units[i] = p.On, p.Off, p.Units
	}
	fOn, fOff := makeFunnel(ons, units), makeFunnel(offs, units)

	fmt.Fprintln(w, "A. THE FUNNEL, volume gate ON (pricing.DefaultFitOptions() as shipped)")
	writeFunnel(w, fOn)
	fmt.Fprintln(w)
	fmt.Fprintln(w, "B. THE SAME FUNNEL, volume gate OFF (MinMeanUnitsPerDay = 0):")
	fmt.Fprintln(w, "   what the estimator would have answered before the gate existed")
	writeFunnel(w, fOff)
	fmt.Fprintln(w)

	fmt.Fprintln(w, "C. USABLE ESTIMATES")
	fmt.Fprintln(w, "   half-width = (CIHigh - CILow) / 2 of the 95% interval; quantiles are type 7 (linear interpolation)")
	writeDistribution(w, "gate ON ", onUsable(prods, func(p *product) pricing.Estimate { return p.On }), fOn)
	writeDistribution(w, "gate OFF", onUsable(prods, func(p *product) pricing.Estimate { return p.Off }), fOff)
	fmt.Fprintln(w)

	byVolume := sortByVolume(prods)
	fmt.Fprintf(w, "   The %d highest-volume products (by kept units). units/day = units over observations, zero days included;\n", topN)
	fmt.Fprintln(w, "   prices = distinct prices on days with sales; days = days with sales / observations (open days in range).")
	fmt.Fprintln(w, "   A refusal made after a fit shows the point estimate in brackets.")
	writeProductTable(w, byVolume[:min(topN, len(byVolume))])
	fmt.Fprintln(w)

	var usableOn []*product
	for _, p := range byVolume {
		if p.On.Usable() {
			usableOn = append(usableOn, p)
		}
	}
	fmt.Fprintf(w, "   Every product usable with the gate ON (%d), by kept units", len(usableOn))
	if len(usableOn) > maxUsableRows {
		fmt.Fprintf(w, "; first %d shown, %d not shown", maxUsableRows, len(usableOn)-maxUsableRows)
	}
	fmt.Fprintln(w, ":")
	if len(usableOn) == 0 {
		fmt.Fprintln(w, "   (none)")
	} else {
		writeProductTable(w, usableOn[:min(maxUsableRows, len(usableOn))])
	}
	fmt.Fprintln(w)

	conf := writeConfounding(w, c.lines, prods, usableOn, open, onOpt, offOpt)

	fF := writeCorrected(w, c, prods, onOpt, offOpt)

	fmt.Fprintln(w, "E. WHAT THIS SHOWS")
	for _, l := range whatThisShows(sum, fOn, fOff, conf, fF) {
		fmt.Fprintf(w, "   %s\n", l)
	}
}

// correctedRule is rule R2b, written after the first run, before the second.
var correctedRule = []string{
	"R2b (corrected rule, added after the first run): R2 drops a cancellation but keeps the order it reversed,",
	"    so a reversed order still counted as a sale. Here, after R0-R5, each cancellation line (Invoice \"C...\",",
	"    Quantity < 0, with a Customer ID, product StockCode), taken in time order, looks at the kept lines with the",
	"    same Customer ID and StockCode dated at or before it. If one has exactly the cancelled quantity left, the",
	"    latest such line is removed. Otherwise the latest line with more than that left has the quantity taken off",
	"    (a partial cancellation; added after review). Otherwise nothing is removed. Price need not match.",
	"    A cancellation with no Customer ID cannot be tied to an order and is not matched.",
}

// correctedFunnels is what "What this shows" quotes from section F.
type correctedFunnels struct {
	matched, partial, units, cancels int
	on, off                          funnel
}

// writeCorrected is section F: sections A-C again with rule R2b. Sections A-D
// above are the primary result and are not changed by it.
func writeCorrected(w io.Writer, c *cleaner, primary []*product, onOpt, offOpt pricing.FitOptions) correctedFunnels {
	var out correctedFunnels
	lines, matched, partial, units := netCancellations(c.lines, c.cancels)
	out.matched, out.partial, out.units, out.cancels = matched, partial, units, len(c.cancels)
	open := openDays(lines)
	byCode, codes := byProduct(lines)
	prods, _ := buildProducts(byCode, codes, open, c, onOpt, offOpt)

	fmt.Fprintln(w, "F. SECOND RUN WITH ONE RULE CORRECTED (cancelled orders netted out)")
	fmt.Fprintln(w, "   Sections A-D are the primary result and stand as printed. This section repeats A-C with one rule added")
	fmt.Fprintln(w, "   after the first run showed it was needed; section D is not recomputed.")
	for _, r := range correctedRule {
		fmt.Fprintf(w, "   %s\n", r)
	}
	fmt.Fprintf(w, "   cancellation lines eligible to match: %d; lines removed whole: %d; lines reduced: %d; units taken off: %d\n",
		len(c.cancels), matched, partial, units)
	fmt.Fprintf(w, "   not matchable (product cancellations with no Customer ID): %d lines, %d units, still counted as sales\n",
		c.guestCancelLines, c.guestCancelUnits)
	if len(open) > 0 {
		fmt.Fprintf(w, "   kept lines now: %d; store-open days: %d; products: %d\n", len(lines), len(open), len(prods))
	}
	fmt.Fprintln(w)

	ons := make([]pricing.Estimate, len(prods))
	offs := make([]pricing.Estimate, len(prods))
	us := make([]int, len(prods))
	for i, p := range prods {
		ons[i], offs[i], us[i] = p.On, p.Off, p.Units
	}
	out.on, out.off = makeFunnel(ons, us), makeFunnel(offs, us)
	fmt.Fprintln(w, "  F.A funnel, volume gate ON")
	writeFunnel(w, out.on)
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  F.B funnel, volume gate OFF (what the estimator would have answered before the gate existed)")
	writeFunnel(w, out.off)
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  F.C usable estimates")
	writeDistribution(w, "gate ON ", onUsable(prods, func(p *product) pricing.Estimate { return p.On }), out.on)
	writeDistribution(w, "gate OFF", onUsable(prods, func(p *product) pricing.Estimate { return p.Off }), out.off)
	fmt.Fprintln(w)
	before := map[string]pricing.Estimate{}
	for _, p := range primary {
		before[p.Code] = p.On
	}
	after := map[string]pricing.Estimate{}
	for _, p := range prods {
		after[p.Code] = p.On
	}
	var lost, gained []string
	for _, p := range sortByVolume(primary) {
		a, ok := after[p.Code]
		if p.On.Usable() && (!ok || !a.Usable()) {
			r := "no kept lines left"
			if ok {
				r = fmtEst(a)
			}
			lost = append(lost, fmt.Sprintf("%s (%s -> %s)", p.Code, fmtEst(p.On), r))
		}
	}
	for _, p := range sortByVolume(prods) {
		if b := before[p.Code]; p.On.Usable() && !b.Usable() {
			gained = append(gained, fmt.Sprintf("%s (%s -> %s)", p.Code, fmtEst(b), fmtEst(p.On)))
		}
	}
	fmt.Fprintf(w, "   Gate ON, usable in section A but not here: %d\n", len(lost))
	for _, l := range lost {
		fmt.Fprintf(w, "     %s\n", l)
	}
	fmt.Fprintf(w, "   Gate ON, usable here but not in section A: %d\n", len(gained))
	for _, l := range gained {
		fmt.Fprintf(w, "     %s\n", l)
	}
	fmt.Fprintln(w)

	fmt.Fprintf(w, "   The %d highest-volume products under the corrected rule:\n", topN)
	byVolume := sortByVolume(prods)
	writeProductTable(w, byVolume[:min(topN, len(byVolume))])
	fmt.Fprintln(w)
	return out
}

func onUsable(prods []*product, pick func(*product) pricing.Estimate) []pricing.Estimate {
	var out []pricing.Estimate
	for _, p := range prods {
		if e := pick(p); e.Usable() {
			out = append(out, e)
		}
	}
	return out
}

func writeFunnel(w io.Writer, f funnel) {
	fmt.Fprintf(w, "  %-62s %8s %8s %10s %8s\n", "", "products", "%prod", "units", "%units")
	remN, remU := f.Products, f.Units
	row := func(label string) {
		fmt.Fprintf(w, "  %-62s %8d %7.1f%% %10d %7.1f%%\n", label, remN, pct(remN, f.Products), remU, pct(remU, f.TotalUnits))
	}
	sub := func(code pricing.Refusal) {
		n, u := f.Refused[code], f.RefusedU[code]
		remN -= n
		remU -= u
		fmt.Fprintf(w, "    refused %-54s %8d %7.1f%% %10d %7.1f%%\n", code, n, pct(n, f.Products), u, pct(u, f.TotalUnits))
	}
	row("products (at least one kept line)")
	sub(pricing.RefusalTooFewDays)
	row("not refused for too_few_days")
	sub(pricing.RefusalTooFewPrices)
	sub(pricing.RefusalNoPriceVariance)
	row("not refused for too_few_distinct_prices / insufficient_price_var.")
	sub(pricing.RefusalVolumeTooLow)
	row("not refused for volume_too_low = fit attempted")
	sub(pricing.RefusalSingular)
	sub(pricing.RefusalIndistinct)
	sub(pricing.RefusalWrongSign)
	sub(pricing.RefusalImprecise)
	row("USABLE")
	if remN != f.Usable || remU != f.UsableU {
		panic("funnel accounting does not add up")
	}
	for code := range f.Refused {
		known := false
		for _, r := range allRefusals {
			known = known || r == code
		}
		if !known {
			panic(fmt.Sprintf("refusal %q is not in allRefusals", code))
		}
	}
}

func writeDistribution(w io.Writer, label string, ests []pricing.Estimate, f funnel) {
	el := make([]float64, len(ests))
	hw := make([]float64, len(ests))
	below, between := 0, 0
	for i, e := range ests {
		el[i] = e.Elasticity
		hw[i] = (e.CIHigh - e.CILow) / 2
		switch {
		case e.Elasticity < -1:
			below++
		case e.Elasticity < 0:
			between++
		}
	}
	el, hw = sortedCopy(el), sortedCopy(hw)
	fmt.Fprintf(w, "  %s: %d usable; elasticity < -1: %d (%.1f%%); -1 <= elasticity < 0: %d (%.1f%%); refused for a positive sign: %d\n",
		label, len(ests), below, pct(below, len(ests)), between, pct(between, len(ests)), f.Refused[pricing.RefusalWrongSign])
	if len(ests) == 0 {
		return
	}
	ps := []float64{0, 0.05, 0.25, 0.5, 0.75, 0.95, 1}
	fmt.Fprintf(w, "    %-12s", "")
	for _, h := range []string{"min", "5%", "25%", "median", "75%", "95%", "max"} {
		fmt.Fprintf(w, " %8s", h)
	}
	fmt.Fprintln(w)
	for _, s := range []struct {
		name string
		v    []float64
	}{{"elasticity", el}, {"half-width", hw}} {
		fmt.Fprintf(w, "    %-12s", s.name)
		for _, p := range ps {
			fmt.Fprintf(w, " %8.3f", quantile(s.v, p))
		}
		fmt.Fprintln(w)
	}
}

func writeProductTable(w io.Writer, ps []*product) {
	fmt.Fprintf(w, "  %-9s %-30s %8s %8s %6s %9s  %-38s %s\n",
		"StockCode", "description", "units", "units/d", "prices", "days", "gate ON", "gate OFF")
	for _, p := range ps {
		fmt.Fprintf(w, "  %-9s %-30s %8d %8.1f %6d %4d/%-4d  %-38s %s\n",
			p.Code, cut(p.Desc, descWidth), p.Units, p.On.MeanUnitsPerDay, p.Prices,
			p.On.Days, len(p.Obs), fmtEst(p.On), fmtEst(p.Off))
	}
}

// confounding holds the figures "What this shows" quotes.
type confounding struct {
	pairs, multi, units, multiUnits int
	splitEligible, splitEmpty       int
	splitLower                      int
	medianRatio                     float64
	retailN                         int
	retailUsableOn, retailUsableOff int
	diffOn, diffOff                 []float64 // sorted, retail - all lines
	sameDays, sameLowLarger         int
	sameEqual                       int
}

func writeConfounding(w io.Writer, lines []line, prods, usableOn []*product, open []int, onOpt, offOpt pricing.FitOptions) confounding {
	var cf confounding
	fmt.Fprintln(w, "D. EVIDENCE ABOUT CONFOUNDING BY ORDER SIZE")
	fmt.Fprintln(w, "   The dataset's description says many of this retailer's customers are wholesalers, and wholesale unit prices")
	fmt.Fprintln(w, "   commonly fall with order size; (ii) tests that here. Where they do, a day's price and a day's units can both")
	fmt.Fprintln(w, "   be driven by who ordered that day, and a negative slope can appear with no buyer responding to a price.")
	fmt.Fprintln(w)

	cf.pairs, cf.multi, cf.units, cf.multiUnits = multiPriceDays(lines)
	fmt.Fprintln(w, "  (i) Product-days (a product on a day it sold) with more than one distinct unit price among its lines:")
	fmt.Fprintf(w, "      %d of %d product-days (%.1f%%), carrying %d of %d units (%.1f%%)\n",
		cf.multi, cf.pairs, pct(cf.multi, cf.pairs), cf.multiUnits, cf.units, pct(cf.multiUnits, cf.units))
	fmt.Fprintln(w, "      Can show: how often one day's sales of one product happened at several prices, which the daily")
	fmt.Fprintln(w, "      series collapses to the price with the most units. Cannot show: why the prices differed.")
	fmt.Fprintln(w)

	var ratios []float64
	for _, p := range prods {
		if len(p.Lines) < minLinesForSplit {
			continue
		}
		cf.splitEligible++
		large, small, ok := sizeSplit(p.Lines)
		if !ok {
			cf.splitEmpty++
			continue
		}
		if large < small {
			cf.splitLower++
		}
		ratios = append(ratios, large/small)
	}
	sort.Float64s(ratios)
	cf.medianRatio = quantile(ratios, 0.5)
	compared := cf.splitEligible - cf.splitEmpty
	fmt.Fprintf(w, "  (ii) Products with at least %d kept lines: %d. Split each product's lines at its lower-median line\n", minLinesForSplit, cf.splitEligible)
	fmt.Fprintln(w, "      quantity m: large = quantity >= m, small = quantity < m; compare units-weighted mean unit prices.")
	fmt.Fprintf(w, "      %d excluded because every line is >= m (no small group); %d compared.\n", cf.splitEmpty, compared)
	fmt.Fprintf(w, "      large lines priced strictly lower than small lines: %d of %d (%.1f%%)\n", cf.splitLower, compared, pct(cf.splitLower, compared))
	fmt.Fprintf(w, "      median of (large mean price / small mean price): %.3f\n", cf.medianRatio)
	fmt.Fprintln(w, "      Can show: whether bigger lines of the same product paid less per unit. Cannot show: that this")
	fmt.Fprintln(w, "      moved the daily series, or by how much it biases any one estimate.")
	fmt.Fprintln(w)

	cf.retailN = len(usableOn)
	fmt.Fprintf(w, "  (iii) The %d products usable with the gate ON, re-estimated from only their lines with quantity <= m\n", cf.retailN)
	fmt.Fprintln(w, "      (retail-sized lines; same store-open days; range = first to last day with a retained line).")
	codesOn := map[pricing.Refusal]int{}
	codesOff := map[pricing.Refusal]int{}
	for _, p := range usableOn {
		obs := observations(retailLines(p.Lines), open)
		on := pricing.EstimateElasticity(p.Code, obs, onOpt)
		off := pricing.EstimateElasticity(p.Code, obs, offOpt)
		if on.Usable() {
			cf.retailUsableOn++
			cf.diffOn = append(cf.diffOn, on.Elasticity-p.On.Elasticity)
		} else {
			codesOn[on.Refusal]++
		}
		if off.Usable() {
			cf.retailUsableOff++
			cf.diffOff = append(cf.diffOff, off.Elasticity-p.On.Elasticity)
		} else {
			codesOff[off.Refusal]++
		}
	}
	sort.Float64s(cf.diffOn)
	sort.Float64s(cf.diffOff)
	writeRetail := func(label string, usable int, codes map[pricing.Refusal]int, diff []float64) {
		fmt.Fprintf(w, "      %s: %d of %d still usable; refused: %s\n", label, usable, cf.retailN, refusalList(codes))
		if len(diff) == 0 {
			fmt.Fprintln(w, "        no product usable both ways, so no difference to report")
			return
		}
		pos := 0
		for _, d := range diff {
			if d > 0 {
				pos++
			}
		}
		fmt.Fprintf(w, "        retail-only minus all-lines elasticity (n=%d): 25%% %+.3f, median %+.3f, 75%% %+.3f; less negative in %d of %d\n",
			len(diff), quantile(diff, 0.25), quantile(diff, 0.5), quantile(diff, 0.75), pos, len(diff))
	}
	writeRetail("gate ON (primary)", cf.retailUsableOn, codesOn, cf.diffOn)
	writeRetail("gate OFF (secondary: cutting lines cuts volume, which the gate alone would refuse)", cf.retailUsableOff, codesOff, cf.diffOff)
	fmt.Fprintln(w, "      Can show: how much an estimate moves when the largest lines are taken out. Cannot show: which of")
	fmt.Fprintln(w, "      the two is nearer the truth; the retail-only series is thinner and has confounders of its own.")
	fmt.Fprintln(w, "      Caution (added after review): keeping lines by quantity cuts off the high-unit lines, which by itself")
	fmt.Fprintln(w, "      flattens daily units and pulls a slope toward zero. This shift is expected with or without confounding.")
	fmt.Fprintln(w)

	cf.sameDays, cf.sameLowLarger, cf.sameEqual = sameDaySplit(lines)
	fmt.Fprintln(w, "  (iv) Added after review, because (ii) pools two years and a price that rose while order sizes fell would")
	fmt.Fprintln(w, "      look the same. Inside each product-day with more than one price: was the mean line quantity at that")
	fmt.Fprintln(w, "      day's lowest price larger than at its highest price?")
	fmt.Fprintf(w, "      lowest-price lines were larger: %d of %d product-days (%.1f%%); equal: %d; smaller: %d\n",
		cf.sameLowLarger, cf.sameDays, pct(cf.sameLowLarger, cf.sameDays), cf.sameEqual, cf.sameDays-cf.sameLowLarger-cf.sameEqual)
	fmt.Fprintln(w, "      Can show: that on the same day, for the same product, the cheaper lines were the bigger ones, which")
	fmt.Fprintln(w, "      time cannot explain. Cannot show: how much this moves any one estimate.")
	fmt.Fprintln(w)
	return cf
}

func refusalList(m map[pricing.Refusal]int) string {
	var parts []string
	for _, r := range allRefusals {
		if m[r] > 0 {
			parts = append(parts, fmt.Sprintf("%s %d", r, m[r]))
		}
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, ", ")
}
