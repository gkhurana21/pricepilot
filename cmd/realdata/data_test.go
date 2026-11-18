package main

import (
	"reflect"
	"testing"
	"time"

	"github.com/gkhurana21/pricepilot/enforcer"
	"github.com/gkhurana21/pricepilot/pricing"
)

func at10(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 10, 30, 0, 0, time.UTC) }

// dayOf is the Observation.Day of a calendar date.
func dayOf(y int, m time.Month, d int) int {
	return int(time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Sub(epoch).Hours() / 24)
}

// handRows is a small history built so that every rule and every
// day-construction case fires exactly where the test says it does.
//
//	Jan 4  A sells 10 @ 2.55 and 6 @ 2.10 (two invoices): dominant 255
//	Jan 5  no kept line for anything: closed, no observation
//	       (a cancellation of A with positive quantity, a POST line, a
//	       zero-quantity line and a zero-price line all fall on this day)
//	Jan 6  only B sells: open, so A gets Units 0 at its carried price 255
//	Jan 7  A sells 5 @ 3.00 and 5 @ 2.50: tie, the lower price wins
//	Jan 8  closed again (only a non-product line)
//	Jan 9  A sells 4 @ 2.50, its last sale day
//	Jan 11 B sells, after A's last sale: no A observation
func handRows() []row {
	return []row{
		{Sheet: 0, Invoice: "100", StockCode: "85123A", Quantity: 10, Price: 2.55, Time: at10(2010, 1, 4), Description: "HEART"},
		{Sheet: 0, Invoice: "101", StockCode: "85123A", Quantity: 6, Price: 2.10, Time: at10(2010, 1, 4), Description: "HEART"},
		{Sheet: 0, Invoice: "C102", StockCode: "85123A", Quantity: 50, Price: 2.55, Time: at10(2010, 1, 5)},
		{Sheet: 0, Invoice: "103", StockCode: "POST", Quantity: 1, Price: 18, Time: at10(2010, 1, 5)},
		{Sheet: 0, Invoice: "104", StockCode: "85123A", Quantity: 0, Price: 2.55, Time: at10(2010, 1, 5)},
		{Sheet: 0, Invoice: "105", StockCode: "85123A", Quantity: 3, Price: 0, Time: at10(2010, 1, 5)},
		{Sheet: 0, Invoice: "106", StockCode: "85123A", Quantity: 3, Price: 0.004, Time: at10(2010, 1, 5)},
		{Sheet: 0, Invoice: "107", StockCode: "22041", Quantity: 7, Price: 1.25, Time: at10(2010, 1, 6), Description: "B"},
		{Sheet: 0, Invoice: "108", StockCode: "85123A", Quantity: 5, Price: 3.00, Time: at10(2010, 1, 7), Description: "HEART HANGING"},
		{Sheet: 0, Invoice: "108", StockCode: "85123A", Quantity: 5, Price: 2.50, Time: at10(2010, 1, 7), Description: "HEART HANGING"},
		{Sheet: 0, Invoice: "109", StockCode: "M", Quantity: 1, Price: 4, Time: at10(2010, 1, 8)},
		{Sheet: 0, Invoice: "110", StockCode: "85123A", Quantity: -2, Price: 2.50, Time: at10(2010, 1, 9), Bad: "Quantity is not an integer"},
		// Second sheet: this line repeats one the first sheet holds, field for
		// field, and must be dropped even though it would otherwise be kept.
		{Sheet: 1, Invoice: "107", StockCode: "22041", Quantity: 7, Price: 1.25, Time: at10(2010, 1, 6), Description: "B"},
		{Sheet: 1, Invoice: "200", StockCode: "85123A", Quantity: 4, Price: 2.50, Time: at10(2010, 1, 9), Description: "HEART"},
		{Sheet: 1, Invoice: "201", StockCode: "22041", Quantity: 2, Price: 1.25, Time: at10(2010, 1, 11), Description: "B"},
	}
}

func TestCleaningRulesCountEachDropOnce(t *testing.T) {
	c := newCleaner()
	for _, r := range handRows() {
		c.add(r)
	}
	want := cleanCounts{
		Read:            15,
		ReadBySheet:     []int{12, 3},
		DupOfEarlier:    1,
		Malformed:       1,
		Cancelled:       1,
		QtyNonPositive:  1,
		PriceNonPos:     1,
		PriceRoundsZero: 1,
		NonProduct:      2,
		Kept:            7,
	}
	if !reflect.DeepEqual(c.counts, want) {
		t.Fatalf("counts = %+v\nwant     %+v", c.counts, want)
	}
	sum := c.counts.DupOfEarlier + c.counts.Malformed + c.counts.Cancelled + c.counts.QtyNonPositive +
		c.counts.PriceNonPos + c.counts.PriceRoundsZero + c.counts.NonProduct + c.counts.Kept
	if sum != c.counts.Read {
		t.Fatalf("drops + kept = %d, read = %d", sum, c.counts.Read)
	}
	// "HEART" has 3 kept lines, "HEART HANGING" 2.
	if got := c.description("85123A"); got != "HEART" {
		t.Errorf("description = %q", got)
	}
}

func TestObservationsSkipClosedDaysAndFillOpenOnes(t *testing.T) {
	c := newCleaner()
	for _, r := range handRows() {
		c.add(r)
	}
	open := openDays(c.lines)
	wantOpen := []int{dayOf(2010, 1, 4), dayOf(2010, 1, 6), dayOf(2010, 1, 7), dayOf(2010, 1, 9), dayOf(2010, 1, 11)}
	if !reflect.DeepEqual(open, wantOpen) {
		t.Fatalf("open days = %v, want %v (Jan 5 and Jan 8 have only dropped lines)", open, wantOpen)
	}

	prods, codes := byProduct(c.lines)
	if !reflect.DeepEqual(codes, []string{"22041", "85123A"}) {
		t.Fatalf("products = %v", codes)
	}

	gotA := observations(prods["85123A"], open)
	wantA := []pricing.Observation{
		{Day: dayOf(2010, 1, 4), Price: 255, Units: 16}, // 10 @ 255 beats 6 @ 210
		{Day: dayOf(2010, 1, 6), Price: 255, Units: 0},  // open, no sale: carried price
		{Day: dayOf(2010, 1, 7), Price: 250, Units: 10}, // 5 v 5: the lower price
		{Day: dayOf(2010, 1, 9), Price: 250, Units: 4},  // last sale; Jan 8 closed, Jan 11 after the range
	}
	if !reflect.DeepEqual(gotA, wantA) {
		t.Errorf("85123A observations:\n got %+v\nwant %+v", gotA, wantA)
	}

	// B sold Jan 6 and Jan 11; Jan 7 and Jan 9 were open, so they are zeros
	// at 1.25. The duplicate from the second sheet did not double Jan 6.
	gotB := observations(prods["22041"], open)
	wantB := []pricing.Observation{
		{Day: dayOf(2010, 1, 6), Price: 125, Units: 7},
		{Day: dayOf(2010, 1, 7), Price: 125, Units: 0},
		{Day: dayOf(2010, 1, 9), Price: 125, Units: 0},
		{Day: dayOf(2010, 1, 11), Price: 125, Units: 2},
	}
	if !reflect.DeepEqual(gotB, wantB) {
		t.Errorf("22041 observations:\n got %+v\nwant %+v", gotB, wantB)
	}
}

func TestDominantPriceTiesToLower(t *testing.T) {
	if got := dominantPrice(map[enforcer.Cents]int{300: 5, 250: 5, 199: 4}); got != 250 {
		t.Errorf("got %d, want 250", got)
	}
	if got := dominantPrice(map[enforcer.Cents]int{300: 6, 250: 5}); got != 300 {
		t.Errorf("got %d, want 300", got)
	}
}

func TestParseRow(t *testing.T) {
	cols := columns{invoice: 0, code: 1, desc: 2, qty: 3, date: 4, price: 5, customer: 6}
	good := []cell{{V: "489434", Num: true}, {V: "85048", Num: true}, {V: "LED BALL"}, {V: "12", Num: true},
		{V: "40148.322916666664", Num: true}, {V: "6.95", Num: true}, {V: "13085", Num: true}}
	r := parseRow(0, good, cols, false)
	if r.Bad != "" || r.Invoice != "489434" || r.Customer != "13085" || r.StockCode != "85048" || r.Quantity != 12 || r.Price != 6.95 ||
		!r.Time.Equal(time.Date(2009, 12, 1, 7, 45, 0, 0, time.UTC)) {
		t.Errorf("good row parsed as %+v", r)
	}

	text := []cell{{V: " c489449 "}, {V: " 15056bl "}, {}, {V: "-1", Num: true},
		{V: "40148.5", Num: true}, {V: "2.1", Num: true}}
	if r := parseRow(0, text, cols, false); r.Bad != "" || r.Invoice != "C489449" || r.StockCode != "15056BL" {
		t.Errorf("text codes parsed as %+v", r)
	}

	for name, cells := range map[string][]cell{
		"fractional quantity": {{V: "1", Num: true}, {V: "1", Num: true}, {}, {V: "1.5", Num: true}, {V: "40148", Num: true}, {V: "1", Num: true}},
		"text price":          {{V: "1", Num: true}, {V: "1", Num: true}, {}, {V: "1", Num: true}, {V: "40148", Num: true}, {V: "1.00"}},
		"missing date":        {{V: "1", Num: true}, {V: "1", Num: true}, {}, {V: "1", Num: true}, {}, {V: "1", Num: true}},
		"missing code":        {{V: "1", Num: true}, {}, {}, {V: "1", Num: true}, {V: "40148", Num: true}, {V: "1", Num: true}},
		"short row":           {{V: "1", Num: true}, {V: "1", Num: true}},
	} {
		if r := parseRow(0, cells, cols, false); r.Bad == "" {
			t.Errorf("%s: should be malformed, parsed as %+v", name, r)
		}
	}
}

func TestHeaderColumnsFindsColumnsByName(t *testing.T) {
	cells := []cell{{V: "Price"}, {V: "Invoice"}, {V: "StockCode"}, {V: "Description"}, {V: "Quantity"}, {V: "InvoiceDate"},
		{V: "Customer ID"}, {V: "Country"}}
	cols, err := headerColumns(cells)
	if err != nil {
		t.Fatal(err)
	}
	if cols != (columns{invoice: 1, code: 2, desc: 3, qty: 4, date: 5, price: 0, customer: 6}) {
		t.Errorf("cols = %+v", cols)
	}
	if _, err := headerColumns(cells[1:]); err == nil {
		t.Error("a header without Price should fail")
	}
}

func TestLowerMedianQty(t *testing.T) {
	ls := func(q ...int) []line {
		out := make([]line, len(q))
		for i, v := range q {
			out[i] = line{Qty: v}
		}
		return out
	}
	if got := lowerMedianQty(ls(12, 1, 6, 24)); got != 6 {
		t.Errorf("even count: got %d, want 6", got)
	}
	if got := lowerMedianQty(ls(5, 1, 3)); got != 3 {
		t.Errorf("odd count: got %d, want 3", got)
	}
}

// TestNetCancellations covers the corrected rule R2b.
func TestNetCancellations(t *testing.T) {
	jan := func(d, h int) time.Time { return time.Date(2011, 1, d, h, 0, 0, 0, time.UTC) }
	rows := []row{
		// Customer 1 orders 100 twice; one cancellation of 100 removes the
		// later of the two orders made before it, not the earlier one.
		{Invoice: "1", StockCode: "23166", Quantity: 100, Price: 1.04, Time: jan(3, 9), Customer: "1"},
		{Invoice: "2", StockCode: "23166", Quantity: 100, Price: 1.04, Time: jan(5, 9), Customer: "1"},
		{Invoice: "C3", StockCode: "23166", Quantity: -100, Price: 1.04, Time: jan(5, 10), Customer: "1"},
		// An order placed after the cancellation is never matched by it.
		{Invoice: "4", StockCode: "23166", Quantity: 100, Price: 1.04, Time: jan(6, 9), Customer: "1"},
		// A smaller quantity is a partial cancellation: it comes off the latest
		// earlier line that still has more than that on it (Jan 6: 100 -> 1).
		{Invoice: "C5", StockCode: "23166", Quantity: -99, Time: jan(7, 9), Customer: "1"},
		// A different customer or product: no match.
		{Invoice: "C6", StockCode: "23166", Quantity: -100, Time: jan(7, 9), Customer: "2"},
		{Invoice: "C7", StockCode: "22041", Quantity: -100, Time: jan(7, 9), Customer: "1"},
		// No customer on either side: never matched.
		{Invoice: "8", StockCode: "22041", Quantity: 5, Price: 1, Time: jan(3, 9)},
		{Invoice: "C9", StockCode: "22041", Quantity: -5, Time: jan(4, 9)},
		// A cancellation of a non-product line is not kept aside.
		{Invoice: "C10", StockCode: "POST", Quantity: -1, Time: jan(4, 9), Customer: "1"},
		// Two cancellations for one order: only one can match it.
		{Invoice: "11", StockCode: "21212", Quantity: 24, Price: 0.55, Time: jan(3, 9), Customer: "3"},
		{Invoice: "C12", StockCode: "21212", Quantity: -24, Time: jan(4, 9), Customer: "3"},
		{Invoice: "C13", StockCode: "21212", Quantity: -24, Time: jan(4, 10), Customer: "3"},
	}
	c := newCleaner()
	for _, r := range rows {
		c.add(r)
	}
	if len(c.cancels) != 6 {
		t.Fatalf("kept aside %d cancellations, want 6 (C9 has no customer, C10 is not a product)", len(c.cancels))
	}
	kept, matched, partial, units := netCancellations(c.lines, c.cancels)
	if matched != 2 || partial != 1 || units != 223 {
		t.Fatalf("matched %d lines, %d partial, %d units; want 2, 1, 223", matched, partial, units)
	}
	if kept[1].Qty != 1 {
		t.Errorf("the Jan 6 order of 100 with 99 cancelled should have 1 left, has %d", kept[1].Qty)
	}
	if c.guestCancelLines != 1 || c.guestCancelUnits != 5 {
		t.Errorf("guest cancellations: %d lines, %d units; want 1, 5", c.guestCancelLines, c.guestCancelUnits)
	}
	var got []time.Time
	for _, l := range kept {
		got = append(got, l.At)
	}
	want := []time.Time{jan(3, 9), jan(6, 9), jan(3, 9)} // 23166 Jan 3, 23166 Jan 6, 22041 Jan 3
	if !reflect.DeepEqual(got, want) || kept[2].Product != "22041" {
		t.Errorf("kept %+v", kept)
	}
	// The primary lines are untouched.
	if len(c.lines) != 5 {
		t.Errorf("netting changed the primary lines: %d", len(c.lines))
	}
}

// A second sheet that reuses an invoice number is a repeat only line by line.
func TestR0KeepsALineTheEarlierSheetNeverHeld(t *testing.T) {
	at := time.Date(2010, 12, 3, 10, 0, 0, 0, time.UTC)
	c := newCleaner()
	c.add(row{Sheet: 0, Invoice: "536365", StockCode: "22041", Quantity: 6, Price: 1.25, Time: at, Customer: "1"})
	// Sheet 2: the same line again (a repeat), then a line sheet 1 never had.
	c.add(row{Sheet: 1, Invoice: "536365", StockCode: "22041", Quantity: 6, Price: 1.25, Time: at, Customer: "1"})
	c.add(row{Sheet: 1, Invoice: "536365", StockCode: "21212", Quantity: 24, Price: 0.55, Time: at, Customer: "1"})
	// The repeat can be used once only: a second identical line is new.
	c.add(row{Sheet: 1, Invoice: "536365", StockCode: "22041", Quantity: 6, Price: 1.25, Time: at, Customer: "1"})
	if c.counts.DupOfEarlier != 1 || c.counts.DupInvoiceNew != 2 || c.counts.Kept != 3 {
		t.Fatalf("dropped %d, new under a repeated invoice %d, kept %d; want 1, 2, 3",
			c.counts.DupOfEarlier, c.counts.DupInvoiceNew, c.counts.Kept)
	}
}
