package bridge

import (
	"bytes"
	"encoding/json"
	"math"
	"math/rand"
	"strings"
	"testing"
	"time"

	"github.com/gkhurana21/pricepilot/enforcer"
	"github.com/gkhurana21/pricepilot/pricing"
)

// ---- helpers ---------------------------------------------------------------

type envelope struct {
	OK    bool            `json:"ok"`
	Out   json.RawMessage `json:"out"`
	Error string          `json:"error"`
}

func call(t *testing.T, op string, payload any) (envelope, error) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return callRaw(t, `{"op":`+quote(op)+`,"in":`+string(raw)+`}`)
}

func quote(s string) string { b, _ := json.Marshal(s); return string(b) }

func callRaw(t *testing.T, in string) (envelope, error) {
	t.Helper()
	out, err := Handle([]byte(in))
	var env envelope
	if jerr := json.Unmarshal(out, &env); jerr != nil {
		t.Fatalf("Handle output is not JSON: %v\n%s", jerr, out)
	}
	if env.OK != (err == nil) {
		t.Fatalf("ok=%v but err=%v (must agree)", env.OK, err)
	}
	if !env.OK && env.Error == "" {
		t.Fatalf("error response without a message: %s", out)
	}
	return env, err
}

// randomRequest builds a decide request from plain structs. It is a small copy
// of the idea in the enforcer's tests, deliberately not imported.
func randomRequest(rng *rand.Rand) enforcer.Request {
	now := time.Date(2026, 8, 16, 9, 0, 0, 0, time.UTC)
	pol := enforcer.Policy{
		ID: "pol", Version: rng.Intn(9) + 1,
		MarginFloor:      enforcer.MarginFloor{Basis: []enforcer.MarginBasis{enforcer.MarginOnPrice, enforcer.MarginOnCost}[rng.Intn(2)], Rate: enforcer.BasisPoints(rng.Intn(6000))},
		RespectMAP:       rng.Intn(2) == 0,
		MaxDecreaseBP:    enforcer.BasisPoints(rng.Intn(4000)),
		MaxIncreaseBP:    enforcer.BasisPoints(rng.Intn(4000)),
		Velocity:         enforcer.Velocity{MinDaysBetweenChanges: rng.Intn(20), MaxChangesPerWindow: rng.Intn(4), WindowDays: 90},
		Rounding:         []enforcer.RoundingMode{enforcer.RoundNone, enforcer.RoundCharm99, enforcer.RoundWholeDollar, enforcer.RoundNearestFive}[rng.Intn(4)],
		MinChangeBP:      enforcer.BasisPoints(rng.Intn(500)),
		MinConfidenceBP:  enforcer.BasisPoints(rng.Intn(8000)),
		MaxSKUsChangedBP: enforcer.BasisPoints([]int{0, 0, 2000, 5000, 10000}[rng.Intn(5)]),
		Exclusions:       enforcer.Exclusions{SKUIDs: []string{"sku-3"}, Tags: []string{"locked"}},
	}
	if rng.Intn(10) == 0 {
		pol.MaxDecreaseBP = -5 // invalid policies must round-trip too
	}
	n := []int{0, 1, 2, 5, 17, 40}[rng.Intn(6)]
	items := make([]enforcer.Item, n)
	for i := range items {
		cur := enforcer.Cents(200 + rng.Intn(20000))
		id := "sku-" + string(rune('0'+i%10)) + string(rune('a'+i/10))
		if i == 3 {
			id = "sku-3"
		}
		st := enforcer.SKUState{
			ID: id, VariantGID: "gid://v/" + id, CurrentPrice: cur,
			UnitCost: enforcer.Cents(rng.Intn(int(cur))), MAPPrice: enforcer.Cents(rng.Intn(2)) * cur / 2,
			Tags: []string{"t"}, Collections: []string{"c"},
			ChangesInWindow: rng.Intn(4), InventoryQuantity: rng.Intn(100),
		}
		if rng.Intn(3) > 0 {
			st.LastPriceChangeAt = now.Add(-time.Duration(rng.Intn(60*24)) * time.Hour)
		}
		if rng.Intn(5) == 0 {
			st.Tags = []string{"locked"}
		}
		items[i] = enforcer.Item{SKU: st, Proposal: enforcer.Proposal{
			SKUID: id, ProposedPrice: enforcer.Cents(float64(cur) * (0.5 + rng.Float64())),
			ConfidenceBP: enforcer.BasisPoints(rng.Intn(10001)), Rationale: "r",
			Signals: []enforcer.Signal{{Name: "s", ContribuBP: 5, Description: "d"}},
		}}
	}
	return enforcer.Request{Policy: pol, Now: now, Items: items}
}

// ---- decide ----------------------------------------------------------------

func TestDecideMatchesDirectCallByteForByte(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 250; i++ {
		req := randomRequest(rng)
		env, err := call(t, "decide", req)
		if err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		want, _ := json.Marshal(enforcer.DecideBatch(req))
		// Re-encode what came back through the wire type, as a client would.
		var res enforcer.Result
		if err := json.Unmarshal(env.Out, &res); err != nil {
			t.Fatalf("case %d: out does not decode as enforcer.Result: %v", i, err)
		}
		got, _ := json.Marshal(res)
		if !bytes.Equal(got, want) || !bytes.Equal(env.Out, want) {
			t.Fatalf("case %d: bridge output differs from DecideBatch\n got %s\nwant %s", i, env.Out, want)
		}
	}
}

func TestDecideRejectsBadInput(t *testing.T) {
	good := `{"policy":{"id":"p","version":1,"max_decrease_bp":1000,"max_increase_bp":1000},"now":"2026-08-16T09:00:00Z","items":[{"sku":{"id":"a","current_price":1850,"unit_cost":900},"proposal":{"sku_id":"a","proposed_price":1900,"confidence_bp":9000}}]}`
	if _, err := callRaw(t, `{"op":"decide","in":`+good+`}`); err != nil {
		t.Fatalf("baseline request should succeed: %v", err)
	}
	cases := map[string]string{
		"float for cents": strings.Replace(good, `"current_price":1850`, `"current_price":18.5`, 1),
		"unknown field":   strings.Replace(good, `"now"`, `"nwo":1,"now"`, 1),
		"unknown nested":  strings.Replace(good, `"unit_cost":900`, `"unit_cost":900,"cost":1`, 1),
		"zero now":        strings.Replace(good, `"2026-08-16T09:00:00Z"`, `"0001-01-01T00:00:00Z"`, 1),
		"missing now":     strings.Replace(good, `"now":"2026-08-16T09:00:00Z",`, ``, 1),
		"string for int":  strings.Replace(good, `"version":1`, `"version":"1"`, 1),
	}
	for name, payload := range cases {
		if _, err := callRaw(t, `{"op":"decide","in":`+payload+`}`); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	for name, raw := range map[string]string{
		"malformed":        `{"op":"decide","in":{`,
		"not json":         `hello`,
		"empty":            ``,
		"trailing garbage": `{"op":"policy_hash","in":{}} x`,
		"unknown envelope": `{"op":"policy_hash","in":{},"extra":1}`,
		"missing in":       `{"op":"policy_hash"}`,
		"null in":          `{"op":"policy_hash","in":null}`,
	} {
		if _, err := callRaw(t, raw); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestDecideOffsetTimestampDecidesLikeZ(t *testing.T) {
	rng := rand.New(rand.NewSource(11))
	req := randomRequest(rng)
	for len(req.Items) == 0 {
		req = randomRequest(rng)
	}
	z, err := call(t, "decide", req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(req)
	off := strings.Replace(string(raw), `"now":"2026-08-16T09:00:00Z"`, `"now":"2026-08-16T14:30:00+05:30"`, 1)
	if off == string(raw) {
		t.Fatal("test setup: replacement did not apply")
	}
	o, err := callRaw(t, `{"op":"decide","in":`+off+`}`)
	if err != nil {
		t.Fatal(err)
	}
	var a, b enforcer.Result
	_ = json.Unmarshal(z.Out, &a)
	_ = json.Unmarshal(o.Out, &b)
	if !a.DecidedAt.Equal(b.DecidedAt) {
		t.Fatalf("instants differ: %v vs %v", a.DecidedAt, b.DecidedAt)
	}
	a.DecidedAt, b.DecidedAt = time.Time{}, time.Time{}
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	if !bytes.Equal(ja, jb) {
		t.Fatalf("offset timestamp decided differently\n%s\n%s", ja, jb)
	}
	if !bytes.Equal(z.Out, o.Out) {
		t.Errorf("output should be normalised to UTC, so byte-identical:\n%s\n%s", z.Out, o.Out)
	}
}

// ---- policy_hash -----------------------------------------------------------

func TestPolicyHashMatches(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	for i := 0; i < 20; i++ {
		pol := randomRequest(rng).Policy
		env, err := call(t, "policy_hash", pol)
		if err != nil {
			t.Fatal(err)
		}
		var out struct {
			PolicyHash string `json:"policy_hash"`
		}
		if err := json.Unmarshal(env.Out, &out); err != nil {
			t.Fatal(err)
		}
		if out.PolicyHash != enforcer.PolicyHash(pol) || !strings.HasPrefix(out.PolicyHash, "sha256:") {
			t.Fatalf("got %q want %q", out.PolicyHash, enforcer.PolicyHash(pol))
		}
	}
	if _, err := callRaw(t, `{"op":"policy_hash","in":{"idd":"x"}}`); err == nil {
		t.Error("unknown policy field must be an error")
	}
}

// ---- unknown op ------------------------------------------------------------

func TestUnknownOpNamesOpAndListsValid(t *testing.T) {
	_, err := callRaw(t, `{"op":"frobnicate","in":{}}`)
	if err == nil {
		t.Fatal("expected error")
	}
	for _, want := range []string{"frobnicate", "decide", "estimate", "policy_hash"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q should mention %q", err, want)
		}
	}
}

// ---- estimate --------------------------------------------------------------

type wireObs struct {
	Day     int  `json:"day"`
	Price   int  `json:"price"`
	Units   int  `json:"units"`
	OnPromo bool `json:"on_promo"`
}
type wireSKU struct {
	SKU          enforcer.SKUState `json:"sku"`
	Group        string            `json:"group"`
	Observations []wireObs         `json:"observations"`
}
type wireIn struct {
	SKUs []wireSKU `json:"skus"`
}
type wireResult struct {
	SKUID            string             `json:"sku_id"`
	Estimate         json.RawMessage    `json:"estimate"`
	Proposal         *enforcer.Proposal `json:"proposal"`
	NoProposalReason string             `json:"no_proposal_reason"`
	NoProposalCode   string             `json:"no_proposal_code"`
}
type wireOut struct {
	Options json.RawMessage `json:"options"`
	Results []wireResult    `json:"results"`
}

type fixture struct {
	in   wireIn
	obs  [][]pricing.Observation
	sku  []enforcer.SKUState
	grp  []string
	name []string
}

func buildCatalog() fixture {
	rng := rand.New(rand.NewSource(20260816))
	rich := func(l ...enforcer.Cents) pricing.PriceSchedule {
		return pricing.PriceSchedule{Levels: l, HoldDays: 14, PromoEvery: 45, PromoDays: 5, PromoDiscountBP: 1500}
	}
	type p struct {
		id, group string
		beta      float64
		cost, cur enforcer.Cents
		sched     pricing.PriceSchedule
		days      int
		base      float64
	}
	// 5.2 is the pipeline's baseLogDemand: about 180 a day at the listed price.
	const base = 5.2
	cat := []p{
		{"yirg", "beans", -2.4, 900, 1620, rich(1900, 2100, 2300, 2500), 365, base},
		{"huila", "beans", -1.9, 1000, 1800, rich(1600, 1800, 2000, 2200), 365, base},
		{"kenya", "beans", -2.8, 1100, 1780, rich(2200, 2450, 2700, 2950), 365, base},
		{"decaf", "beans", -2.1, 1050, 2300, rich(2000, 2200, 2400, 2600), 365, base},
		{"chemex", "equipment", -2.0, 3100, 5200, pricing.PriceSchedule{Levels: []enforcer.Cents{5200}, HoldDays: 400}, 365, base},
		{"slowbean", "beans", -2.2, 900, 1900, rich(1700, 1900, 2100, 2300), 365, 2.0},
		{"nocost", "beans", -2.3, 0, 2000, rich(1800, 2000, 2200, 2400), 365, base},
	}
	f := fixture{}
	for _, c := range cat {
		m := pricing.DemandModel{
			SKUID: c.id, Elasticity: c.beta,
			BaseLogDemand:   c.base - c.beta*math.Log(float64(c.cur)/100),
			WeeklySeasonAmp: 0.20, AnnualSeasonAmp: 0.15, PromoLift: 0.40, NoiseSD: 0.15,
		}
		obs := m.Generate(c.sched, c.days, rng)
		sku := enforcer.SKUState{ID: c.id, VariantGID: "gid://v/" + c.id, CurrentPrice: c.cur, UnitCost: c.cost,
			LastPriceChangeAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
		w := wireSKU{SKU: sku, Group: c.group}
		for _, o := range obs {
			w.Observations = append(w.Observations, wireObs{o.Day, int(o.Price), o.Units, o.OnPromo})
		}
		f.in.SKUs = append(f.in.SKUs, w)
		f.obs = append(f.obs, obs)
		f.sku = append(f.sku, sku)
		f.grp = append(f.grp, c.group)
		f.name = append(f.name, c.id)
	}
	return f
}

func TestEstimateMatchesDirectCalls(t *testing.T) {
	f := buildCatalog()
	env, err := call(t, "estimate", f.in)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(env.Out, []byte("NaN")) || bytes.Contains(env.Out, []byte("Inf")) {
		t.Fatal("output contains NaN/Inf")
	}
	var out wireOut
	if err := json.Unmarshal(env.Out, &out); err != nil {
		t.Fatal(err)
	}

	opt := pricing.DefaultFitOptions()
	ests := make([]pricing.Estimate, len(f.sku))
	for i := range f.sku {
		ests[i] = pricing.EstimateElasticity(f.name[i], f.obs[i], opt)
	}
	pooled := pricing.PoolByGroup(ests, f.grp, opt)

	var optGot map[string]any
	_ = json.Unmarshal(out.Options, &optGot)
	if optGot["min_mean_units_per_day"] != float64(45) {
		t.Errorf("options should report the volume gate, got %v", optGot)
	}
	if len(out.Results) != len(f.sku) {
		t.Fatalf("got %d results want %d", len(out.Results), len(f.sku))
	}

	codes := map[string]string{}
	for i, r := range out.Results {
		if r.SKUID != f.name[i] {
			t.Fatalf("order changed at %d: %s", i, r.SKUID)
		}
		prop, refusal, note := pricing.Propose(pooled[i], f.sku[i])
		hasProp := refusal == pricing.RefusalNone && prop.ProposedPrice != 0
		if hasProp != (r.Proposal != nil) {
			t.Fatalf("%s: proposal presence differs (direct %v)", r.SKUID, hasProp)
		}
		if hasProp {
			if r.Proposal.ProposedPrice != prop.ProposedPrice || r.Proposal.ConfidenceBP != prop.ConfidenceBP {
				t.Errorf("%s: proposal differs: %+v vs %+v", r.SKUID, *r.Proposal, prop)
			}
			if r.NoProposalCode != "" || r.NoProposalReason != "" {
				t.Errorf("%s: proposal present but reason set", r.SKUID)
			}
		} else {
			if r.NoProposalCode != string(refusal) {
				t.Errorf("%s: code %q want %q", r.SKUID, r.NoProposalCode, refusal)
			}
			if note == "" {
				note = string(refusal)
			}
			if r.NoProposalReason != note {
				t.Errorf("%s: reason %q want %q", r.SKUID, r.NoProposalReason, note)
			}
		}
		codes[r.SKUID] = r.NoProposalCode
		var e map[string]any
		if err := json.Unmarshal(r.Estimate, &e); err != nil {
			t.Fatal(err)
		}
		if e["method"] != string(pooled[i].Method) || e["refusal"] != string(pooled[i].Refusal) {
			t.Errorf("%s: estimate method/refusal differ: %v", r.SKUID, e)
		}
		if int(e["confidence_bp"].(float64)) != int(pooled[i].ConfidenceBP()) {
			t.Errorf("%s: confidence differs", r.SKUID)
		}
	}
	if codes["chemex"] != "too_few_distinct_prices" {
		t.Errorf("single-price SKU: code %q", codes["chemex"])
	}
	if codes["slowbean"] != "volume_too_low" {
		t.Errorf("low-volume SKU: code %q", codes["slowbean"])
	}
	nc := out.Results[6]
	if nc.Proposal != nil || !strings.Contains(nc.NoProposalReason, "no unit cost") {
		t.Errorf("zero-cost SKU: %+v", nc)
	}
	if out.Results[0].Proposal == nil {
		t.Error("expected the first rich SKU to get a proposal; fixture is not exercising the happy path")
	}
}

func TestEstimateUnsortedObservationsAndInputUntouched(t *testing.T) {
	f := buildCatalog()
	env1, err := call(t, "estimate", f.in)
	if err != nil {
		t.Fatal(err)
	}
	rng := rand.New(rand.NewSource(5))
	for i := range f.in.SKUs {
		o := f.in.SKUs[i].Observations
		rng.Shuffle(len(o), func(a, b int) { o[a], o[b] = o[b], o[a] })
	}
	env2, err := call(t, "estimate", f.in)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(env1.Out, env2.Out) {
		t.Fatal("shuffled observations changed the result")
	}
}

func TestEstimateEmptyAndValidation(t *testing.T) {
	env, err := call(t, "estimate", wireIn{})
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Results []json.RawMessage `json:"results"`
	}
	if err := json.Unmarshal(env.Out, &out); err != nil {
		t.Fatal(err)
	}
	if out.Results == nil || len(out.Results) != 0 {
		t.Fatalf("empty skus must give an empty (non-null) results list: %s", env.Out)
	}
	if _, err := callRaw(t, `{"op":"estimate","in":{}}`); err != nil {
		t.Errorf("missing skus should behave as empty: %v", err)
	}

	mk := func(id string, obs ...wireObs) wireSKU {
		return wireSKU{SKU: enforcer.SKUState{ID: id, CurrentPrice: 1000, UnitCost: 500}, Group: "g", Observations: obs}
	}
	bad := map[string]wireIn{
		"duplicate ids":   {SKUs: []wireSKU{mk("a"), mk("a")}},
		"negative units":  {SKUs: []wireSKU{mk("a", wireObs{0, 1000, -1, false})}},
		"zero price sold": {SKUs: []wireSKU{mk("a", wireObs{0, 0, 3, false})}},
		"negative price":  {SKUs: []wireSKU{mk("a", wireObs{0, -5, 3, false})}},
		"empty id":        {SKUs: []wireSKU{mk("")}},
	}
	for name, in := range bad {
		if _, err := call(t, "estimate", in); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	if _, err := call(t, "estimate", wireIn{SKUs: []wireSKU{mk("a", wireObs{0, 0, 0, false})}}); err != nil {
		t.Errorf("zero price on a zero-unit day is allowed: %v", err)
	}
	for name, raw := range map[string]string{
		"unknown obs field": `{"skus":[{"sku":{"id":"a"},"group":"g","observations":[{"day":1,"price":5,"units":1,"promo":true}]}]}`,
		"float price":       `{"skus":[{"sku":{"id":"a"},"group":"g","observations":[{"day":1,"price":5.5,"units":1}]}]}`,
		"unknown top":       `{"skus":[],"opts":{}}`,
	} {
		if _, err := callRaw(t, `{"op":"estimate","in":`+raw+`}`); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestEstimateNeverEmitsNaN(t *testing.T) {
	// Degenerate histories drive NaN/Inf through the fit and the DTO.
	rng := rand.New(rand.NewSource(9))
	var in wireIn
	for i := 0; i < 12; i++ {
		s := wireSKU{SKU: enforcer.SKUState{ID: "s" + string(rune('a'+i)), CurrentPrice: 1000, UnitCost: 400}, Group: []string{"x", "y"}[i%2]}
		n := []int{0, 1, 5, 60, 120}[rng.Intn(5)]
		for d := 0; d < n; d++ {
			s.Observations = append(s.Observations, wireObs{d, 900 + rng.Intn(3)*100, rng.Intn(4) * (i % 3), d%9 == 0})
		}
		in.SKUs = append(in.SKUs, s)
	}
	env, err := call(t, "estimate", in)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(env.Out, []byte("NaN")) || bytes.Contains(env.Out, []byte("Inf")) {
		t.Fatalf("NaN/Inf leaked: %s", env.Out)
	}
	var out wireOut
	if err := json.Unmarshal(env.Out, &out); err != nil || len(out.Results) != 12 {
		t.Fatalf("unmarshal: %v (%d results)", err, len(out.Results))
	}
}

func TestNullableFloat(t *testing.T) {
	for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if nullableFloat(v) != nil {
			t.Errorf("%v should map to nil", v)
		}
	}
	if p := nullableFloat(1.5); p == nil || *p != 1.5 {
		t.Error("finite value should pass through")
	}
}

// ---- robustness ------------------------------------------------------------

func TestHandleNeverPanicsOnRandomBytes(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	prefixes := []string{"", `{"op":"decide","in":`, `{"op":"estimate","in":`, `{"op":"policy_hash","in":`}
	for i := 0; i < 2000; i++ {
		b := make([]byte, rng.Intn(80))
		rng.Read(b)
		in := append([]byte(prefixes[i%len(prefixes)]), b...)
		out, err := Handle(in)
		var env envelope
		if jerr := json.Unmarshal(out, &env); jerr != nil {
			t.Fatalf("input %q: output not JSON: %s", in, out)
		}
		if env.OK != (err == nil) {
			t.Fatalf("input %q: ok/err disagree", in)
		}
	}
}

func TestPanicBecomesErrorResponse(t *testing.T) {
	ops["boom"] = func(json.RawMessage) (any, error) { panic("kaboom") }
	defer delete(ops, "boom")
	out, err := Handle([]byte(`{"op":"boom","in":{}}`))
	if err == nil || !strings.Contains(err.Error(), "kaboom") {
		t.Fatalf("want panic surfaced as error, got %v", err)
	}
	var env envelope
	if jerr := json.Unmarshal(out, &env); jerr != nil || env.OK {
		t.Fatalf("bad response: %s", out)
	}
}
