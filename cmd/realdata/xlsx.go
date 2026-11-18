package main

import (
	"archive/zip"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
)

// This file is a minimal .xlsx reader built on archive/zip and encoding/xml
// only. It reads what this command needs and nothing more: sheet names in
// workbook order, shared strings, inline strings and numeric cells, streamed
// row by row so a 160 MB sheet never sits in memory as a whole.

const relNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

// cell is one spreadsheet cell. Num is true when the cell holds a number (no
// string type), so a caller can tell the number 85048 from the text "85048"
// and never reads a text code such as "2E3" as a float.
type cell struct {
	V   string
	Num bool
}

type sheetRef struct {
	Name string
	Path string // the part's path inside the zip
}

type workbook struct {
	zr       *zip.Reader
	closer   io.Closer
	sheets   []sheetRef
	shared   []string
	date1904 bool
}

func openWorkbookFile(name string) (*workbook, error) {
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	wb, err := openWorkbook(f, st.Size())
	if err != nil {
		f.Close()
		return nil, err
	}
	wb.closer = f
	return wb, nil
}

func (wb *workbook) Close() error {
	if wb.closer != nil {
		return wb.closer.Close()
	}
	return nil
}

func openWorkbook(r io.ReaderAt, size int64) (*workbook, error) {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, err
	}
	wb := &workbook{zr: zr}

	var book struct {
		Pr struct {
			Date1904 string `xml:"date1904,attr"`
		} `xml:"workbookPr"`
		Sheets []struct {
			Name string `xml:"name,attr"`
			RID  string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
		} `xml:"sheets>sheet"`
	}
	if err := wb.unmarshalPart("xl/workbook.xml", &book); err != nil {
		return nil, err
	}
	wb.date1904 = book.Pr.Date1904 == "1" || book.Pr.Date1904 == "true"

	var rels struct {
		Rels []struct {
			ID     string `xml:"Id,attr"`
			Type   string `xml:"Type,attr"`
			Target string `xml:"Target,attr"`
		} `xml:"Relationship"`
	}
	if err := wb.unmarshalPart("xl/_rels/workbook.xml.rels", &rels); err != nil {
		return nil, err
	}
	targets := map[string]string{}
	sharedPath := ""
	for _, r := range rels.Rels {
		p := resolveTarget(r.Target)
		targets[r.ID] = p
		if strings.HasSuffix(r.Type, "/sharedStrings") {
			sharedPath = p
		}
	}
	for _, s := range book.Sheets {
		p, ok := targets[s.RID]
		if !ok {
			return nil, fmt.Errorf("sheet %q: relationship %q not found", s.Name, s.RID)
		}
		wb.sheets = append(wb.sheets, sheetRef{Name: s.Name, Path: p})
	}
	if sharedPath != "" {
		if wb.shared, err = wb.readSharedStrings(sharedPath); err != nil {
			return nil, err
		}
	}
	return wb, nil
}

func resolveTarget(t string) string {
	if strings.HasPrefix(t, "/") {
		return strings.TrimPrefix(t, "/")
	}
	return path.Clean(path.Join("xl", t))
}

func (wb *workbook) open(name string) (io.ReadCloser, error) {
	for _, f := range wb.zr.File {
		if f.Name == name {
			return f.Open()
		}
	}
	return nil, fmt.Errorf("%s: not in the workbook", name)
}

func (wb *workbook) unmarshalPart(name string, v any) error {
	rc, err := wb.open(name)
	if err != nil {
		return err
	}
	defer rc.Close()
	return xml.NewDecoder(rc).Decode(v)
}

// readSharedStrings concatenates every <t> inside each <si>, so rich-text runs
// read as their plain text, and skips phonetic runs (<rPh>), which are
// annotations rather than content.
func (wb *workbook) readSharedStrings(name string) ([]string, error) {
	rc, err := wb.open(name)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	d := xml.NewDecoder(rc)
	var (
		out     []string
		b       strings.Builder
		inSI    bool
		inT     bool
		phonDep int
	)
	for {
		tok, err := d.RawToken()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "si":
				inSI = true
				b.Reset()
			case "rPh":
				phonDep++
			case "t":
				inT = inSI && phonDep == 0
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "si":
				out = append(out, b.String())
				inSI = false
			case "rPh":
				phonDep--
			case "t":
				inT = false
			}
		case xml.CharData:
			if inT {
				b.Write(t)
			}
		}
	}
	return out, nil
}

// Rows streams the rows of sheet i (0-based, workbook order) to fn. Each row is
// a slice indexed by column (A=0), with empty cells left as the zero cell, so
// a missing value never shifts the columns after it. rowNum is 1-based.
func (wb *workbook) Rows(i int, fn func(rowNum int, cells []cell) error) error {
	if i < 0 || i >= len(wb.sheets) {
		return fmt.Errorf("sheet %d out of range", i)
	}
	rc, err := wb.open(wb.sheets[i].Path)
	if err != nil {
		return err
	}
	defer rc.Close()
	d := xml.NewDecoder(rc)

	var (
		row      []cell
		rowNum   int
		col      int    // current cell's column
		typ      string // current cell's t attribute
		inV      bool
		inIS     bool
		inT      bool
		phonDep  int
		val      strings.Builder
		haveCell bool
	)
	for {
		tok, err := d.RawToken()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("%s row %d: %w", wb.sheets[i].Name, rowNum, err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "row":
				row = row[:0]
				rowNum++
				col = -1
				for _, a := range t.Attr {
					if a.Name.Local == "r" {
						if n, err := strconv.Atoi(a.Value); err == nil {
							rowNum = n
						}
					}
				}
			case "c":
				haveCell = true
				typ = ""
				val.Reset()
				next := col + 1
				for _, a := range t.Attr {
					switch a.Name.Local {
					case "t":
						typ = a.Value
					case "r":
						c, err := columnIndex(a.Value)
						if err != nil {
							return fmt.Errorf("%s row %d: %w", wb.sheets[i].Name, rowNum, err)
						}
						next = c
					}
				}
				col = next
			case "v":
				inV = haveCell
			case "is":
				inIS = haveCell
			case "rPh":
				phonDep++
			case "t":
				inT = inIS && phonDep == 0
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "v":
				inV = false
			case "is":
				inIS = false
			case "rPh":
				phonDep--
			case "t":
				inT = false
			case "c":
				c, err := wb.cellValue(typ, val.String())
				if err != nil {
					return fmt.Errorf("%s row %d col %d: %w", wb.sheets[i].Name, rowNum, col, err)
				}
				for len(row) <= col {
					row = append(row, cell{})
				}
				row[col] = c
				haveCell = false
			case "row":
				if err := fn(rowNum, row); err != nil {
					return err
				}
			}
		case xml.CharData:
			if inV || inT {
				val.Write(t)
			}
		}
	}
}

func (wb *workbook) cellValue(typ, raw string) (cell, error) {
	switch typ {
	case "s":
		if raw == "" {
			return cell{}, nil
		}
		n, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil || n < 0 || n >= len(wb.shared) {
			return cell{}, fmt.Errorf("bad shared string index %q", raw)
		}
		return cell{V: wb.shared[n]}, nil
	case "inlineStr", "str", "e":
		return cell{V: raw}, nil
	case "b":
		return cell{V: raw}, nil
	case "", "n":
		if raw == "" {
			return cell{}, nil
		}
		return cell{V: raw, Num: true}, nil
	}
	return cell{}, fmt.Errorf("unsupported cell type %q", typ)
}

// columnIndex turns the letters of a reference such as "AB12" into 27.
func columnIndex(ref string) (int, error) {
	n := 0
	letters := 0
	for _, r := range ref {
		if r >= 'A' && r <= 'Z' {
			n = n*26 + int(r-'A'+1)
			letters++
			continue
		}
		break
	}
	if letters == 0 {
		return 0, fmt.Errorf("bad cell reference %q", ref)
	}
	return n - 1, nil
}

var errFictitiousDate = errors.New("serial 60 is 1900-02-29, which does not exist")

// excelTime converts an Excel serial date to a wall-clock time, as recorded,
// with no time-zone shift (the value is returned in UTC only as a container).
//
// In the 1900 system serial 1 is 1900-01-01 and Excel counts a 29 February
// 1900 that never happened (serial 60), so serials from 61 on are one day
// ahead of a true count from 1899-12-31. Times are rounded to the nearest
// second, which removes the float artefacts of the stored fraction
// (40148.322916666664 is 07:45:00 exactly).
func excelTime(serial float64, date1904 bool) (time.Time, error) {
	if math.IsNaN(serial) || math.IsInf(serial, 0) || serial < 0 {
		return time.Time{}, fmt.Errorf("bad date serial %v", serial)
	}
	days := math.Floor(serial)
	secs := math.Round((serial - days) * 86400)
	if secs >= 86400 {
		days++
		secs -= 86400
	}
	var base time.Time
	switch {
	case date1904:
		base = time.Date(1904, 1, 1, 0, 0, 0, 0, time.UTC)
	case days >= 61:
		base = time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)
	case days == 60:
		return time.Time{}, errFictitiousDate
	default:
		base = time.Date(1899, 12, 31, 0, 0, 0, 0, time.UTC)
	}
	return base.AddDate(0, 0, int(days)).Add(time.Duration(secs) * time.Second), nil
}
