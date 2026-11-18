package main

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func buildEngine(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "engine")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	return bin
}

func runEngine(t *testing.T, bin, stdin string, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	cmd := exec.Command(bin, args...)
	cmd.Stdin = strings.NewReader(stdin)
	var so, se bytes.Buffer
	cmd.Stdout, cmd.Stderr = &so, &se
	err := cmd.Run()
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return so.String(), se.String(), code
}

func oneJSONLine(t *testing.T, s string) map[string]any {
	t.Helper()
	if !strings.HasSuffix(s, "\n") || strings.Count(s, "\n") != 1 {
		t.Fatalf("stdout must be exactly one newline-terminated line, got %q", s)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, s)
	}
	return m
}

func TestEngineDecideAndErrors(t *testing.T) {
	bin := buildEngine(t)

	req := `{"op":"decide","in":{"policy":{"id":"p","version":1,"max_decrease_bp":1000,"max_increase_bp":1000},"now":"2026-08-16T09:00:00Z","items":[{"sku":{"id":"a","current_price":1850,"unit_cost":900},"proposal":{"sku_id":"a","proposed_price":1900,"confidence_bp":9000}}]}}`
	so, _, code := runEngine(t, bin, req)
	m := oneJSONLine(t, so)
	if code != 0 || m["ok"] != true || m["out"] == nil {
		t.Fatalf("code=%d stdout=%s", code, so)
	}

	so, se, code := runEngine(t, bin, `{"op":"decide","in":{"nope":1}}`)
	m = oneJSONLine(t, so)
	if code != 1 || m["ok"] != false || m["error"] == "" {
		t.Fatalf("code=%d stdout=%s", code, so)
	}
	if se == "" {
		t.Error("diagnostics should go to stderr")
	}

	so, _, code = runEngine(t, bin, ``)
	if m = oneJSONLine(t, so); code != 1 || m["ok"] != false {
		t.Fatalf("empty stdin: code=%d stdout=%s", code, so)
	}
}

func TestEngineVersion(t *testing.T) {
	bin := buildEngine(t)
	so, _, code := runEngine(t, bin, "", "-version")
	want := "github.com/gkhurana21/pricepilot\nops: decide, estimate, policy_hash\n"
	if code != 0 || so != want {
		t.Fatalf("code=%d got %q want %q", code, so, want)
	}
}
