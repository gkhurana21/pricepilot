// Package bridge is the JSON boundary a non-Go caller (the Node server) uses to
// reach the pricing engine through a subprocess. It adds no logic of its own:
// every op decodes strictly, calls the same functions cmd/pipeline calls, and
// encodes the result. See Handle for the wire format.
package bridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strings"

	"github.com/gkhurana21/pricepilot/enforcer"
	"github.com/gkhurana21/pricepilot/pricing"
)

// ModulePath is reported by `engine -version`.
const ModulePath = "github.com/gkhurana21/pricepilot"

type op func(payload json.RawMessage) (any, error)

// ops is the dispatch table. It is a variable (not a switch) so the valid-op
// list in the unknown-op error can never drift from what is implemented.
var ops = map[string]op{
	"decide":      opDecide,
	"estimate":    opEstimate,
	"policy_hash": opPolicyHash,
}

// OpNames returns the valid op names, sorted.
func OpNames() []string {
	names := make([]string, 0, len(ops))
	for n := range ops {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

type request struct {
	Op string          `json:"op"`
	In json.RawMessage `json:"in"`
}

type okResponse struct {
	OK  bool `json:"ok"`
	Out any  `json:"out"`
}

type errResponse struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

// ErrorResponse renders err as the wire error envelope.
func ErrorResponse(err error) []byte {
	b, merr := json.Marshal(errResponse{OK: false, Error: err.Error()})
	if merr != nil {
		return []byte(`{"ok":false,"error":"internal error"}`)
	}
	return b
}

// Handle executes one request envelope {"op": "<name>", "in": <payload>} and
// returns the response JSON: {"ok":true,"out":<payload>} or
// {"ok":false,"error":"<message>"}. err is non-nil exactly when ok is false,
// and out is valid JSON either way. Handle never panics: a panic anywhere
// below is returned as an error response.
//
// Every decode is strict: an unknown field, a float where an integer is
// expected, or trailing bytes is an error, so a misspelled field cannot be
// silently ignored.
func Handle(in []byte) (out []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("internal panic: %v", r)
			out = ErrorResponse(err)
		}
	}()

	result, err := dispatch(in)
	if err != nil {
		return ErrorResponse(err), err
	}
	b, merr := json.Marshal(okResponse{OK: true, Out: result})
	if merr != nil {
		err = fmt.Errorf("encoding response: %v", merr)
		return ErrorResponse(err), err
	}
	return b, nil
}

func dispatch(in []byte) (any, error) {
	var req request
	if err := decodeStrict(in, &req); err != nil {
		return nil, fmt.Errorf("bad envelope: %v", err)
	}
	fn, ok := ops[req.Op]
	if !ok {
		return nil, fmt.Errorf("unknown op %q; valid ops: %s", req.Op, strings.Join(OpNames(), ", "))
	}
	if len(req.In) == 0 || bytes.Equal(bytes.TrimSpace(req.In), []byte("null")) {
		return nil, fmt.Errorf("op %q: missing \"in\" payload", req.Op)
	}
	res, err := fn(req.In)
	if err != nil {
		return nil, fmt.Errorf("op %q: %v", req.Op, err)
	}
	return res, nil
}

// decodeStrict decodes exactly one JSON value into v, rejecting unknown fields
// and trailing data.
func decodeStrict(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		if errors.Is(err, io.EOF) {
			return errors.New("empty input")
		}
		return err
	}
	if _, err := dec.Token(); err != io.EOF {
		return errors.New("unexpected data after the JSON value")
	}
	return nil
}

// ---- decide ----------------------------------------------------------------

// opDecide: payload is exactly enforcer.Request, output exactly
// enforcer.Result, so the wire type is the type the enforcer is fuzzed on.
// The one extra rule is that "now" is required: the zero time would silently
// make every velocity check pass.
func opDecide(raw json.RawMessage) (any, error) {
	var req enforcer.Request
	if err := decodeStrict(raw, &req); err != nil {
		return nil, err
	}
	if req.Now.IsZero() {
		return nil, errors.New(`"now" is required and must not be the zero time`)
	}
	// Normalise the instant to UTC so an offset timestamp and the same instant
	// in "Z" produce byte-identical output.
	req.Now = req.Now.UTC()
	return enforcer.DecideBatch(req), nil
}

// ---- policy_hash -----------------------------------------------------------

func opPolicyHash(raw json.RawMessage) (any, error) {
	var p enforcer.Policy
	if err := decodeStrict(raw, &p); err != nil {
		return nil, err
	}
	h := enforcer.PolicyHash(p)
	if h == "" {
		return nil, errors.New("policy could not be hashed")
	}
	return struct {
		PolicyHash string `json:"policy_hash"`
	}{h}, nil
}

// ---- estimate --------------------------------------------------------------

type estimateIn struct {
	SKUs []skuIn `json:"skus"`
}

type skuIn struct {
	SKU          enforcer.SKUState `json:"sku"`
	Group        string            `json:"group"`
	Observations []obsIn           `json:"observations"`
}

type obsIn struct {
	Day     int   `json:"day"`
	Price   int64 `json:"price"`
	Units   int   `json:"units"`
	OnPromo bool  `json:"on_promo"`
}

type estimateOut struct {
	Options optionsOut  `json:"options"`
	Results []resultOut `json:"results"`
}

type optionsOut struct {
	ControlPromo         bool    `json:"control_promo"`
	WeeklySeasonality    bool    `json:"weekly_seasonality"`
	AnnualSeasonality    bool    `json:"annual_seasonality"`
	Level                float64 `json:"level"`
	MinDays              int     `json:"min_days"`
	MinDistinctPrices    int     `json:"min_distinct_prices"`
	MinLogPriceSD        float64 `json:"min_log_price_sd"`
	MaxRelativeHalfWidth float64 `json:"max_relative_half_width"`
	MinMeanUnitsPerDay   float64 `json:"min_mean_units_per_day"`
}

type resultOut struct {
	SKUID            string             `json:"sku_id"`
	Estimate         estimateDTO        `json:"estimate"`
	Proposal         *enforcer.Proposal `json:"proposal"`
	NoProposalReason string             `json:"no_proposal_reason"`
	NoProposalCode   string             `json:"no_proposal_code"`
}

// estimateDTO mirrors pricing.Estimate with snake_case names. Every float is
// nullable: a refused estimate carries NaN or zero-valued fields, and
// encoding/json fails outright on NaN/Inf.
type estimateDTO struct {
	Elasticity      *float64 `json:"elasticity"`
	StdErr          *float64 `json:"std_err"`
	CILow           *float64 `json:"ci_low"`
	CIHigh          *float64 `json:"ci_high"`
	RSquared        *float64 `json:"r_squared"`
	Shrinkage       *float64 `json:"shrinkage"`
	Level           *float64 `json:"level"`
	Days            int      `json:"days"`
	ZeroDays        int      `json:"zero_days"`
	MeanUnitsPerDay *float64 `json:"mean_units_per_day"`
	DistinctPrices  int      `json:"distinct_prices"`
	LogPriceSD      *float64 `json:"log_price_sd"`
	PromoControl    bool     `json:"promo_control"`
	Controls        []string `json:"controls"`
	Method          string   `json:"method"`
	Refusal         string   `json:"refusal"`
	Note            string   `json:"note"`
	ConfidenceBP    int32    `json:"confidence_bp"`
}

func nullableFloat(f float64) *float64 {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return &f
}

func toDTO(e pricing.Estimate) estimateDTO {
	controls := e.Controls
	if controls == nil {
		controls = []string{}
	}
	return estimateDTO{
		Elasticity:      nullableFloat(e.Elasticity),
		StdErr:          nullableFloat(e.StdErr),
		CILow:           nullableFloat(e.CILow),
		CIHigh:          nullableFloat(e.CIHigh),
		RSquared:        nullableFloat(e.RSquared),
		Shrinkage:       nullableFloat(e.Shrinkage),
		Level:           nullableFloat(e.Level),
		Days:            e.Days,
		ZeroDays:        e.ZeroDays,
		MeanUnitsPerDay: nullableFloat(e.MeanUnitsPerDay),
		DistinctPrices:  e.DistinctPrices,
		LogPriceSD:      nullableFloat(e.LogPriceSD),
		PromoControl:    e.PromoControl,
		Controls:        controls,
		Method:          string(e.Method),
		Refusal:         string(e.Refusal),
		Note:            e.Note,
		ConfidenceBP:    int32(e.ConfidenceBP()),
	}
}

func toOptions(o pricing.FitOptions) optionsOut {
	return optionsOut{
		ControlPromo: o.ControlPromo, WeeklySeasonality: o.WeeklySeasonality, AnnualSeasonality: o.AnnualSeasonality,
		Level: o.Level, MinDays: o.MinDays, MinDistinctPrices: o.MinDistinctPrices,
		MinLogPriceSD: o.MinLogPriceSD, MaxRelativeHalfWidth: o.MaxRelativeHalfWidth,
		MinMeanUnitsPerDay: o.MinMeanUnitsPerDay,
	}
}

// opEstimate runs, in the order cmd/pipeline does: EstimateElasticity per SKU,
// PoolByGroup over all SKUs using each SKU's "group", then Propose per SKU,
// all with pricing.DefaultFitOptions() (volume gate on).
//
// Callers MUST supply days on which nothing sold as observations with units 0,
// not omit them: the estimator's volume gate divides total units by every
// observation supplied, so leaving the empty days out makes a slow SKU look
// busier than it is. Observations need not be sorted. SKUs with an empty group
// are pooled together as one group.
//
// A proposal is null when Propose refuses or yields no price;
// no_proposal_code is then the refusal code (empty when the reason is not an
// estimator refusal, e.g. a missing unit cost) and no_proposal_reason the
// human-readable note.
func opEstimate(raw json.RawMessage) (any, error) {
	var in estimateIn
	if err := decodeStrict(raw, &in); err != nil {
		return nil, err
	}

	seen := make(map[string]bool, len(in.SKUs))
	for i, s := range in.SKUs {
		if s.SKU.ID == "" {
			return nil, fmt.Errorf("skus[%d]: sku.id is required", i)
		}
		if seen[s.SKU.ID] {
			return nil, fmt.Errorf("duplicate sku id %q", s.SKU.ID)
		}
		seen[s.SKU.ID] = true
		for j, o := range s.Observations {
			if o.Units < 0 {
				return nil, fmt.Errorf("sku %q observation %d: negative units (%d)", s.SKU.ID, j, o.Units)
			}
			if o.Units > 0 && o.Price <= 0 {
				return nil, fmt.Errorf("sku %q observation %d: price %d must be positive on a day with sales", s.SKU.ID, j, o.Price)
			}
			if o.Price < 0 {
				return nil, fmt.Errorf("sku %q observation %d: negative price (%d)", s.SKU.ID, j, o.Price)
			}
		}
	}

	opt := pricing.DefaultFitOptions()
	ests := make([]pricing.Estimate, len(in.SKUs))
	groups := make([]string, len(in.SKUs))
	for i, s := range in.SKUs {
		obs := make([]pricing.Observation, len(s.Observations))
		for j, o := range s.Observations {
			obs[j] = pricing.Observation{Day: o.Day, Price: enforcer.Cents(o.Price), Units: o.Units, OnPromo: o.OnPromo}
		}
		sort.SliceStable(obs, func(a, b int) bool { return obs[a].Day < obs[b].Day })
		ests[i] = pricing.EstimateElasticity(s.SKU.ID, obs, opt)
		groups[i] = s.Group
	}
	pooled := pricing.PoolByGroup(ests, groups, opt)

	out := estimateOut{Options: toOptions(opt), Results: make([]resultOut, len(in.SKUs))}
	for i, s := range in.SKUs {
		r := resultOut{SKUID: s.SKU.ID, Estimate: toDTO(pooled[i])}
		prop, refusal, note := pricing.Propose(pooled[i], s.SKU)
		if refusal != pricing.RefusalNone || prop.ProposedPrice == 0 {
			if note == "" {
				note = string(refusal)
			}
			r.NoProposalReason, r.NoProposalCode = note, string(refusal)
		} else {
			p := prop
			r.Proposal = &p
		}
		out.Results[i] = r
	}
	return out, nil
}
