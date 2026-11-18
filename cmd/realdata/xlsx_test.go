package main

import (
	"archive/zip"
	"bytes"
	"testing"
	"time"
)

// buildXLSX writes a two-sheet workbook in memory. The relationship ids are
// deliberately out of step with the part names (the first sheet in workbook
// order lives in sheet2.xml), so a reader that goes by file name rather than
// by workbook order fails.
func buildXLSX(t *testing.T) []byte {
	t.Helper()
	parts := map[string]string{
		"[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
		"xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr/>
<sheets><sheet name="First" sheetId="1" r:id="rId7"/><sheet name="Second" sheetId="2" r:id="rId3"/></sheets>
</workbook>`,
		"xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>
<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`,
		"xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
<si><t>Invoice</t></si>
<si><t>WHITE HANGING HEART</t></si>
<si><r><t>RICH </t></r><r><t>TEXT</t></r><rPh><t>phonetic</t></rPh></si>
<si><t xml:space="preserve"> C536379 </t></si>
</sst>`,
		// First sheet in workbook order. Row 2 has an empty B2 (absent), so
		// C2 must still land in column 2.
		"xl/worksheets/sheet2.xml": `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Code</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>40148.322916666664</v></c><c r="D2"><v>6.95</v></c><c r="E2" s="1"/></row>
<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3"><v>85048</v></c><c r="C3" t="str"><v>2E3</v></c></row>
</sheetData></worksheet>`,
		"xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>3</v></c><c r="AB1"><v>-12</v></c></row>
</sheetData></worksheet>`,
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range []string{"[Content_Types].xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels",
		"xl/sharedStrings.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(parts[name])); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func readAll(t *testing.T, wb *workbook, sheet int) map[int][]cell {
	t.Helper()
	out := map[int][]cell{}
	err := wb.Rows(sheet, func(n int, cells []cell) error {
		out[n] = append([]cell(nil), cells...)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestWorkbookReadsSheetsInWorkbookOrder(t *testing.T) {
	raw := buildXLSX(t)
	wb, err := openWorkbook(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	if len(wb.sheets) != 2 || wb.sheets[0].Name != "First" || wb.sheets[1].Name != "Second" {
		t.Fatalf("sheets = %+v", wb.sheets)
	}
	if wb.sheets[0].Path != "xl/worksheets/sheet2.xml" || wb.sheets[1].Path != "xl/worksheets/sheet1.xml" {
		t.Fatalf("sheet paths = %+v", wb.sheets)
	}

	first := readAll(t, wb, 0)
	if len(first) != 3 {
		t.Fatalf("first sheet has %d rows, want 3", len(first))
	}
	want1 := []cell{{V: "Invoice"}, {V: "Code"}}
	if got := first[1]; !equalCells(got, want1) {
		t.Errorf("row 1 = %+v, want %+v", got, want1)
	}
	// Shared string, empty B2, date serial, number, and a styled cell with no
	// value (E2), which must read as empty rather than as a number.
	want2 := []cell{{V: "WHITE HANGING HEART"}, {}, {V: "40148.322916666664", Num: true}, {V: "6.95", Num: true}, {}}
	if got := first[2]; !equalCells(got, want2) {
		t.Errorf("row 2 = %+v, want %+v", got, want2)
	}
	// Rich text joins its runs and drops the phonetic run; a formula string
	// that looks like a number stays text.
	want3 := []cell{{V: "RICH TEXT"}, {V: "85048", Num: true}, {V: "2E3"}}
	if got := first[3]; !equalCells(got, want3) {
		t.Errorf("row 3 = %+v, want %+v", got, want3)
	}

	second := readAll(t, wb, 1)
	row := second[1]
	if len(row) != 28 || row[0].V != " C536379 " || row[27] != (cell{V: "-12", Num: true}) {
		t.Errorf("second sheet row 1 = %+v (len %d)", row, len(row))
	}
	for c := 1; c < 27; c++ {
		if row[c] != (cell{}) {
			t.Errorf("column %d should be empty, got %+v", c, row[c])
		}
	}

	if err := wb.Rows(2, func(int, []cell) error { return nil }); err == nil {
		t.Error("reading a third sheet should fail")
	}
}

func equalCells(a, b []cell) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestExcelTime1900System(t *testing.T) {
	cases := []struct {
		serial float64
		want   time.Time
	}{
		{1, time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)},
		{59, time.Date(1900, 2, 28, 0, 0, 0, 0, time.UTC)},
		{61, time.Date(1900, 3, 1, 0, 0, 0, 0, time.UTC)},
		{40148.322916666664, time.Date(2009, 12, 1, 7, 45, 0, 0, time.UTC)},
		{40886.5, time.Date(2011, 12, 9, 12, 0, 0, 0, time.UTC)},
		{40148.99999999, time.Date(2009, 12, 2, 0, 0, 0, 0, time.UTC)}, // rounds into the next day
	}
	for _, c := range cases {
		got, err := excelTime(c.serial, false)
		if err != nil {
			t.Errorf("%v: %v", c.serial, err)
			continue
		}
		if !got.Equal(c.want) {
			t.Errorf("%v -> %v, want %v", c.serial, got, c.want)
		}
	}
	if _, err := excelTime(60, false); err == nil {
		t.Error("serial 60 (1900-02-29) should be refused")
	}
	if _, err := excelTime(-1, false); err == nil {
		t.Error("a negative serial should be refused")
	}
	got, err := excelTime(0, true)
	if err != nil || !got.Equal(time.Date(1904, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("1904 system serial 0 -> %v, %v", got, err)
	}
}

func TestColumnIndex(t *testing.T) {
	for ref, want := range map[string]int{"A1": 0, "H9": 7, "Z1": 25, "AA1": 26, "AB12": 27} {
		got, err := columnIndex(ref)
		if err != nil || got != want {
			t.Errorf("columnIndex(%q) = %d, %v; want %d", ref, got, err, want)
		}
	}
	if _, err := columnIndex("12"); err == nil {
		t.Error("a reference without letters should fail")
	}
}
