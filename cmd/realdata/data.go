package main

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gkhurana21/pricepilot/enforcer"
	"github.com/gkhurana21/pricepilot/pricing"
)

// epoch is day 0 of Observation.Day: the first calendar day in the dataset.
// Any fixed date would do (the intercept absorbs the phase); what matters is
// that Day counts calendar days, so the estimator's weekly and annual
// harmonics run on the calendar and not on the count of trading days.
var epoch = time.Date(2009, 12, 1, 0, 0, 0, 0, time.UTC)

// row is one spreadsheet line as read, before any rule is applied.
type row struct {
	Sheet       int
	Invoice     string // trimmed, upper-cased
	StockCode   string // trimmed, upper-cased
	Description string
	Quantity    float64
	Time        time.Time
	Price       float64
	Customer    string // Customer ID; used only by the corrected run (R2b)
	Bad         string // non-empty when the line could not be parsed (rule R1)
}

// line is a kept line: one product sold at one price on one day.
type line struct {
	Product string
	Day     int // calendar days since epoch
	Qty     int
	Pence   enforcer.Cents

	// Used only to net out cancelled orders in the corrected run (R2b).
	Customer string
	At       time.Time
	Seq      int // position in the file, all sheets in order
}

// cancellation is a cancellation line kept aside for R2b.
type cancellation struct {
	Customer string
	Product  string
	Qty      int // positive: the quantity it reverses
	At       time.Time
	Seq      int
}

// cleanCounts records how many lines each rule removed, in rule order.
type cleanCounts struct {
	Read            int
	ReadBySheet     []int
	DupOfEarlier    int // R0
	DupInvoiceNew   int // same invoice number as an earlier sheet, but not a repeat of any of its lines: kept
	Malformed       int // R1
	Cancelled       int // R2
	QtyNonPositive  int // R3
	PriceNonPos     int // R4
	PriceRoundsZero int // R4, second half
	NonProduct      int // R5
	Kept            int
}

// cleaner applies rules R0-R5 in order to a stream of rows. Each dropped line
// is counted under the first rule that drops it.
type cleaner struct {
	counts                             cleanCounts
	invoices                           []map[string]bool // invoices seen in each sheet, before any rule
	sigs                               []map[string]int  // whole-line signatures seen in each sheet, with multiplicity
	guestCancelLines, guestCancelUnits int               // product cancellations with no Customer ID: R2b cannot match them
	lines                              []line
	cancels                            []cancellation
	descs                              map[string]map[string]int // product -> description -> kept lines

	first, last time.Time // InvoiceDate range over every well-formed row read
}

func newCleaner() *cleaner {
	return &cleaner{descs: map[string]map[string]int{}}
}

func (c *cleaner) add(r row) {
	for len(c.invoices) <= r.Sheet {
		c.invoices = append(c.invoices, map[string]bool{})
		c.sigs = append(c.sigs, map[string]int{})
		c.counts.ReadBySheet = append(c.counts.ReadBySheet, 0)
	}
	c.counts.Read++
	c.counts.ReadBySheet[r.Sheet]++
	if r.Bad == "" {
		if c.first.IsZero() || r.Time.Before(c.first) {
			c.first = r.Time
		}
		if r.Time.After(c.last) {
			c.last = r.Time
		}
	}

	// R0: a later sheet repeating a line an earlier sheet already holds. The
	// invoice number alone is not enough: a line is dropped only when an
	// earlier sheet has the same invoice AND an identical line not yet used to
	// drop another one. A line under a repeated invoice number that the
	// earlier sheet never held is counted and kept.
	if r.Invoice != "" {
		sig := lineSignature(r)
		dup := false
		for s := 0; s < r.Sheet; s++ {
			if !c.invoices[s][r.Invoice] {
				continue
			}
			if c.sigs[s][sig] > 0 {
				c.sigs[s][sig]--
				dup = true
			} else {
				c.counts.DupInvoiceNew++
			}
			break
		}
		c.invoices[r.Sheet][r.Invoice] = true
		if dup {
			c.counts.DupOfEarlier++
			return
		}
		c.sigs[r.Sheet][sig]++
	}

	switch {
	case r.Bad != "":
		c.counts.Malformed++
		return
	case strings.HasPrefix(r.Invoice, "C"):
		c.counts.Cancelled++
		if r.Quantity < 0 && isProductCode(r.StockCode) {
			if r.Customer == "" {
				c.guestCancelLines++
				c.guestCancelUnits += int(-r.Quantity)
			} else {
				c.cancels = append(c.cancels, cancellation{
					Customer: r.Customer, Product: r.StockCode, Qty: int(-r.Quantity), At: r.Time, Seq: c.counts.Read,
				})
			}
		}
		return
	case r.Quantity <= 0:
		c.counts.QtyNonPositive++
		return
	case r.Price <= 0:
		c.counts.PriceNonPos++
		return
	}
	pence := math.Round(r.Price * 100)
	if pence == 0 {
		c.counts.PriceRoundsZero++
		return
	}
	if !isProductCode(r.StockCode) {
		c.counts.NonProduct++
		return
	}

	c.counts.Kept++
	y, m, d := r.Time.Date()
	day := int(time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Sub(epoch).Hours() / 24)
	c.lines = append(c.lines, line{
		Product: r.StockCode,
		Day:     day,
		Qty:     int(r.Quantity),
		Pence:   enforcer.Cents(pence),

		Customer: r.Customer,
		At:       r.Time,
		Seq:      c.counts.Read,
	})
	ds := c.descs[r.StockCode]
	if ds == nil {
		ds = map[string]int{}
		c.descs[r.StockCode] = ds
	}
	ds[strings.TrimSpace(r.Description)]++
}

// lineSignature identifies a whole line, so R0 can tell a repeated line from a
// different line that shares an invoice number.
func lineSignature(r row) string {
	return strings.Join([]string{
		r.Invoice, r.StockCode, strings.TrimSpace(r.Description),
		strconv.FormatFloat(r.Quantity, 'g', -1, 64), r.Time.Format(time.RFC3339),
		strconv.FormatFloat(r.Price, 'g', -1, 64), r.Customer, r.Bad,
	}, "\x1f")
}

// isProductCode is rule R5: a product's StockCode starts with a digit.
func isProductCode(code string) bool {
	return code != "" && code[0] >= '0' && code[0] <= '9'
}

// netCancellations is the corrected rule R2b, added after the first run found
// that R2 drops a cancellation but keeps the order it reversed. Taken in time
// order (ties: file order), each cancellation looks at the kept lines with the
// same Customer ID and StockCode dated at or before it:
//
//   - if one has exactly the cancelled quantity still on it, the latest such
//     line is removed whole;
//   - otherwise the latest line with more than the cancelled quantity still on
//     it has that quantity taken off (a partial cancellation: 144 ordered, 72
//     cancelled, 72 remain);
//   - otherwise nothing is removed.
//
// Price need not match. A cancellation with no Customer ID cannot be tied to
// an order and is never matched; the caller reports how many there were.
func netCancellations(lines []line, cancels []cancellation) (kept []line, matched, partial, units int) {
	type key struct{ cust, prod string }
	idx := map[key][]int{}
	for i, l := range lines {
		if l.Customer == "" {
			continue
		}
		k := key{l.Customer, l.Product}
		idx[k] = append(idx[k], i)
	}
	for _, s := range idx {
		sort.SliceStable(s, func(a, b int) bool {
			la, lb := lines[s[a]], lines[s[b]]
			if !la.At.Equal(lb.At) {
				return la.At.Before(lb.At)
			}
			return la.Seq < lb.Seq
		})
	}
	cs := append([]cancellation(nil), cancels...)
	sort.SliceStable(cs, func(a, b int) bool {
		if !cs[a].At.Equal(cs[b].At) {
			return cs[a].At.Before(cs[b].At)
		}
		return cs[a].Seq < cs[b].Seq
	})
	left := make([]int, len(lines)) // quantity still on each line
	for i, l := range lines {
		left[i] = l.Qty
	}
	for _, c := range cs {
		s := idx[key{c.Customer, c.Product}]
		exact, bigger := -1, -1
		for j := len(s) - 1; j >= 0; j-- {
			i := s[j]
			if left[i] == 0 || lines[i].At.After(c.At) {
				continue
			}
			if left[i] == c.Qty {
				exact = i
				break
			}
			if left[i] > c.Qty && bigger < 0 {
				bigger = i
			}
		}
		switch {
		case exact >= 0:
			left[exact] = 0
			matched++
			units += c.Qty
		case bigger >= 0:
			left[bigger] -= c.Qty
			partial++
			units += c.Qty
		}
	}
	kept = make([]line, 0, len(lines)-matched)
	for i, l := range lines {
		if left[i] == 0 {
			continue
		}
		l.Qty = left[i]
		kept = append(kept, l)
	}
	return kept, matched, partial, units
}

// description is the product's most frequent description among its kept
// lines, ties to the lexicographically smallest.
func (c *cleaner) description(product string) string {
	best, bestN := "", -1
	for d, n := range c.descs[product] {
		if n > bestN || (n == bestN && d < best) {
			best, bestN = d, n
		}
	}
	return best
}

// columns holds the position of each needed header in a sheet.
type columns struct {
	invoice, code, desc, qty, date, price, customer int
}

func headerColumns(cells []cell) (columns, error) {
	idx := map[string]int{}
	for i, c := range cells {
		idx[strings.TrimSpace(c.V)] = i
	}
	get := func(name string) (int, error) {
		i, ok := idx[name]
		if !ok {
			return 0, fmt.Errorf("header %q not found", name)
		}
		return i, nil
	}
	var cols columns
	var err error
	for _, f := range []struct {
		dst  *int
		name string
	}{
		{&cols.invoice, "Invoice"}, {&cols.code, "StockCode"}, {&cols.desc, "Description"},
		{&cols.qty, "Quantity"}, {&cols.date, "InvoiceDate"}, {&cols.price, "Price"},
		{&cols.customer, "Customer ID"},
	} {
		if *f.dst, err = get(f.name); err != nil {
			return columns{}, err
		}
	}
	return cols, nil
}

// codeText renders an identifier cell as text. A numeric cell holding an
// integer (Excel stores StockCode 85048 and Invoice 489434 as numbers) is
// printed without a decimal point; a text cell is left exactly as written.
func codeText(c cell) string {
	v := strings.TrimSpace(c.V)
	if c.Num {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f == math.Trunc(f) && math.Abs(f) < 1e15 {
			v = strconv.FormatInt(int64(f), 10)
		}
	}
	return strings.ToUpper(v)
}

func at(cells []cell, i int) cell {
	if i < len(cells) {
		return cells[i]
	}
	return cell{}
}

// parseRow turns one data row into a row, recording why it is malformed
// instead of failing, so rule R1 can count it.
func parseRow(sheet int, cells []cell, cols columns, date1904 bool) row {
	r := row{
		Sheet:       sheet,
		Invoice:     codeText(at(cells, cols.invoice)),
		StockCode:   codeText(at(cells, cols.code)),
		Description: at(cells, cols.desc).V,
		Customer:    codeText(at(cells, cols.customer)),
	}
	num := func(c cell, name string) float64 {
		if r.Bad != "" {
			return 0
		}
		if !c.Num {
			r.Bad = name + " is not a number"
			return 0
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(c.V), 64)
		if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			r.Bad = name + " does not parse"
			return 0
		}
		return f
	}
	switch {
	case r.Invoice == "":
		r.Bad = "no Invoice"
	case r.StockCode == "":
		r.Bad = "no StockCode"
	}
	r.Quantity = num(at(cells, cols.qty), "Quantity")
	if r.Bad == "" && r.Quantity != math.Trunc(r.Quantity) {
		r.Bad = "Quantity is not an integer"
	}
	serial := num(at(cells, cols.date), "InvoiceDate")
	r.Price = num(at(cells, cols.price), "Price")
	if r.Bad == "" {
		t, err := excelTime(serial, date1904)
		if err != nil {
			r.Bad = err.Error()
		}
		r.Time = t
	}
	return r
}

// load reads every sheet in workbook order through the cleaner.
func load(wb *workbook) (*cleaner, error) {
	c := newCleaner()
	for s := range wb.sheets {
		var cols columns
		err := wb.Rows(s, func(n int, cells []cell) error {
			if n == 1 {
				var err error
				cols, err = headerColumns(cells)
				return err
			}
			c.add(parseRow(s, cells, cols, wb.date1904))
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("sheet %q: %w", wb.sheets[s].Name, err)
		}
	}
	return c, nil
}

// openDays is every calendar day with at least one kept line, ascending.
func openDays(lines []line) []int {
	seen := map[int]bool{}
	for _, l := range lines {
		seen[l.Day] = true
	}
	days := make([]int, 0, len(seen))
	for d := range seen {
		days = append(days, d)
	}
	sort.Ints(days)
	return days
}

// byProduct groups lines by product. The map's slices keep the input order.
func byProduct(lines []line) (map[string][]line, []string) {
	m := map[string][]line{}
	for _, l := range lines {
		m[l.Product] = append(m[l.Product], l)
	}
	codes := make([]string, 0, len(m))
	for k := range m {
		codes = append(codes, k)
	}
	sort.Strings(codes)
	return m, codes
}

// dominantPrice is the price with the most units, ties to the lower price.
func dominantPrice(units map[enforcer.Cents]int) enforcer.Cents {
	var best enforcer.Cents
	bestU := -1
	for p, u := range units {
		if u > bestU || (u == bestU && p < best) {
			best, bestU = p, u
		}
	}
	return best
}

// observations builds one product's daily history: one observation per
// store-open day from its first to its last sale day. A day it sold carries
// that day's units at the dominant price; an open day it did not sell is an
// observation with Units 0 at the most recent price, because the estimator
// must see the empty days to judge volume honestly. Closed days are skipped.
func observations(lines []line, open []int) []pricing.Observation {
	if len(lines) == 0 {
		return nil
	}
	perDay := map[int]map[enforcer.Cents]int{}
	first, last := lines[0].Day, lines[0].Day
	for _, l := range lines {
		m := perDay[l.Day]
		if m == nil {
			m = map[enforcer.Cents]int{}
			perDay[l.Day] = m
		}
		m[l.Pence] += l.Qty
		first = min(first, l.Day)
		last = max(last, l.Day)
	}
	var obs []pricing.Observation
	var price enforcer.Cents
	for _, d := range open {
		if d < first || d > last {
			continue
		}
		m, sold := perDay[d]
		if !sold {
			obs = append(obs, pricing.Observation{Day: d, Price: price})
			continue
		}
		units := 0
		for _, u := range m {
			units += u
		}
		price = dominantPrice(m)
		obs = append(obs, pricing.Observation{Day: d, Price: price, Units: units})
	}
	return obs
}

// lowerMedianQty is the lower median of the lines' quantities: the value at
// index floor((n-1)/2) of the sorted quantities.
func lowerMedianQty(lines []line) int {
	q := make([]int, len(lines))
	for i, l := range lines {
		q[i] = l.Qty
	}
	sort.Ints(q)
	return q[(len(q)-1)/2]
}
