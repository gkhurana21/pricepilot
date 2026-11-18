// Package pricepilot_test keeps the documentation honest.
//
// Two things drifted before these tests existed: the demo output moved while
// the README kept quoting the old numbers, and nobody noticed for three months.
// So the output of each demo is pinned in a golden file, and every output
// block quoted in a README must be made of lines that appear in its golden
// file, in order.
//
// After an intended change:
//
//	go test -run TestGolden -update .
package pricepilot_test

import (
	"bufio"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the golden files from the current output")

// goldens maps a name used in README markers to the command that produces it.
var goldens = map[string]string{
	"pipeline": "./cmd/pipeline",
	"demo":     "./cmd/demo",
}

// static names committed result files that no test regenerates, because the
// command that writes them needs a dataset this repo does not redistribute.
// README blocks that quote them are still checked line by line.
var static = map[string]string{
	"realdata": filepath.Join("pricing", "testdata", "realdata_online_retail_ii.txt"),
}

func goldenPath(name string) string {
	if p, ok := static[name]; ok {
		return p
	}
	return filepath.Join("testdata", name+".golden")
}

func runCmd(t *testing.T, pkg string) string {
	t.Helper()
	out, err := exec.Command("go", "run", pkg).CombinedOutput()
	if err != nil {
		t.Fatalf("go run %s: %v\n%s", pkg, err, out)
	}
	return string(out)
}

// TestGoldenOutput fails when a demo prints something other than its golden
// file. Both demos are deterministic: fixed seeds, and a fixed clock.
func TestGoldenOutput(t *testing.T) {
	for name, pkg := range goldens {
		t.Run(name, func(t *testing.T) {
			got := runCmd(t, pkg)
			if *update {
				if err := os.MkdirAll("testdata", 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(goldenPath(name), []byte(got), 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(goldenPath(name))
			if err != nil {
				t.Fatalf("%v (run: go test -run TestGolden -update .)", err)
			}
			if got != string(want) {
				t.Errorf("go run %s no longer matches %s.\nFirst difference: %s\n"+
					"If the change is intended: go test -run TestGolden -update . and then fix any README block that quotes it.",
					pkg, goldenPath(name), firstDiff(string(want), got))
			}
		})
	}
}

func firstDiff(want, got string) string {
	w, g := strings.Split(want, "\n"), strings.Split(got, "\n")
	for i := 0; i < len(w) || i < len(g); i++ {
		var a, b string
		if i < len(w) {
			a = w[i]
		}
		if i < len(g) {
			b = g[i]
		}
		if a != b {
			return "line " + itoa(i+1) + "\n  golden: " + a + "\n  now:    " + b
		}
	}
	return "(none)"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

var marker = regexp.MustCompile(`^<!--\s*golden:\s*([a-z]+)\s*-->$`)

// TestReadmeBlocksQuoteRealOutput checks every fenced block that follows a
// marker line such as
//
//	<!-- golden: pipeline -->
//
// Each non-blank line of the block must appear in that golden file, and the
// lines must appear in the same order. Blocks may skip lines (they are
// excerpts) but may not reword, reorder or invent them. Trailing spaces are
// ignored, because editors strip them.
func TestReadmeBlocksQuoteRealOutput(t *testing.T) {
	files := []string{"README.md", "enforcer/README.md", "pricing/README.md"}
	checked := 0
	for _, file := range files {
		f, err := os.Open(file)
		if err != nil {
			t.Fatal(err)
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 1<<20), 1<<20)

		var (
			lineNo  int
			pending string // golden name from a marker awaiting its fence
			inBlock bool
			block   []string
			name    string
			start   int
		)
		for sc.Scan() {
			lineNo++
			line := sc.Text()
			switch {
			case inBlock && strings.HasPrefix(line, "```"):
				checkBlock(t, file, start, name, block)
				checked++
				inBlock, block = false, nil
			case inBlock:
				block = append(block, line)
			case pending != "" && strings.HasPrefix(line, "```"):
				inBlock, name, start, pending = true, pending, lineNo, ""
			case pending != "" && strings.TrimSpace(line) != "":
				t.Errorf("%s:%d: a golden marker must be followed by a fenced block", file, lineNo)
				pending = ""
			default:
				if m := marker.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
					_, isStatic := static[m[1]]
					if _, ok := goldens[m[1]]; !ok && !isStatic {
						t.Errorf("%s:%d: unknown golden %q", file, lineNo, m[1])
						continue
					}
					pending = m[1]
				}
			}
		}
		f.Close()
		if err := sc.Err(); err != nil {
			t.Fatal(err)
		}
	}
	// A check that finds nothing to check proves nothing.
	if checked < 3 {
		t.Fatalf("only %d marked output block(s) found across %v; expected at least 3", checked, files)
	}
}

func checkBlock(t *testing.T, file string, start int, name string, block []string) {
	t.Helper()
	raw, err := os.ReadFile(goldenPath(name))
	if err != nil {
		t.Fatal(err)
	}
	golden := strings.Split(string(raw), "\n")
	pos, lines := 0, 0
	for i, line := range block {
		want := strings.TrimRight(line, " \t")
		if want == "" {
			continue
		}
		lines++
		found := false
		for ; pos < len(golden); pos++ {
			if strings.TrimRight(golden[pos], " \t") == want {
				found = true
				pos++
				break
			}
		}
		if !found {
			t.Errorf("%s:%d: this line is not in %s (or is out of order):\n  %s",
				file, start+1+i, goldenPath(name), line)
			return
		}
	}
	if lines == 0 {
		t.Errorf("%s:%d: empty golden block", file, start)
	}
}
