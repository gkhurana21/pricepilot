package enforcer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

// Item pairs a SKU's current state with the proposal for it.
type Item struct {
	SKU      SKUState `json:"sku"`
	Proposal Proposal `json:"proposal"`
}

// Request is one repricing run.
type Request struct {
	Policy Policy    `json:"policy"`
	Now    time.Time `json:"now"`
	Items  []Item    `json:"items"`
}

// Summary is the headline a merchant reads before approving a run.
type Summary struct {
	Total    int `json:"total"`
	Approved int `json:"approved"`
	Clamped  int `json:"clamped"`
	Rejected int `json:"rejected"`
	Blocked  int `json:"blocked"`

	Increases int `json:"increases"`
	Decreases int `json:"decreases"`

	// RejectedByRule lets the UI say "42 SKUs blocked by your margin floor"
	// instead of burying the reason in a per-row detail view.
	RejectedByRule map[RuleID]int `json:"rejected_by_rule"`
}

// Result is the complete outcome of a run, pinned to the policy that produced
// it. PolicyHash is what makes a past decision replayable: the audit log stores
// the hash, and re-running the same inputs under the same hash must reproduce
// the same decisions exactly.
type Result struct {
	PolicyHash string     `json:"policy_hash"`
	DecidedAt  time.Time  `json:"decided_at"`
	Summary    Summary    `json:"summary"`
	Decisions  []Decision `json:"decisions"`
}

// DecideBatch evaluates a whole run and applies the one guardrail that cannot
// be evaluated per-SKU: the change budget.
//
// A merchant who sets "never move more than 20% of my catalog in one run" is
// protecting against a systemic estimator failure, not a single bad SKU. That
// makes it a portfolio-level rule, and it needs a deterministic answer to
// "which changes survive the budget?" — highest confidence first, ties broken
// by SKU id, so the same run always produces the same set.
func DecideBatch(req Request) Result {
	decisions := make([]Decision, len(req.Items))
	for i, it := range req.Items {
		decisions[i] = Decide(req.Policy, it.SKU, it.Proposal, req.Now)
	}

	if bp := req.Policy.MaxSKUsChangedBP; bp > 0 && bp < OneHundredPercent {
		applyChangeBudget(decisions, req.Items, bp)
	}

	return Result{
		PolicyHash: PolicyHash(req.Policy),
		DecidedAt:  req.Now,
		Summary:    summarize(decisions),
		Decisions:  decisions,
	}
}

func applyChangeBudget(decisions []Decision, items []Item, bp BasisPoints) {
	type ranked struct {
		idx        int
		confidence BasisPoints
		skuID      string
	}
	var changing []ranked
	for i, d := range decisions {
		if d.Action == ActionApprove || d.Action == ActionClamp {
			changing = append(changing, ranked{i, items[i].Proposal.ConfidenceBP, d.SKUID})
		}
	}

	budget := int(mulBP(Cents(len(decisions)), bp))
	if len(changing) <= budget {
		return
	}

	sort.Slice(changing, func(a, b int) bool {
		if changing[a].confidence != changing[b].confidence {
			return changing[a].confidence > changing[b].confidence
		}
		return changing[a].skuID < changing[b].skuID
	})

	for _, r := range changing[budget:] {
		d := &decisions[r.idx]
		d.Action = ActionReject
		d.FinalPrice = 0
		d.DeltaBP = 0
		d.add(RuleBatchBudget, EffectBlocked, fmt.Sprintf(
			"run change budget of %s (%d of %d SKUs) was filled by higher-confidence proposals",
			bp, budget, len(decisions)))
	}
}

func summarize(decisions []Decision) Summary {
	s := Summary{Total: len(decisions), RejectedByRule: map[RuleID]int{}}
	for _, d := range decisions {
		switch d.Action {
		case ActionApprove:
			s.Approved++
		case ActionClamp:
			s.Clamped++
		case ActionReject:
			s.Rejected++
			if d.Blocked() {
				s.Blocked++
			}
			if n := len(d.Reasons); n > 0 {
				// The last reason is the one that produced the rejection; the
				// earlier entries are bounds that merely narrowed the range.
				s.RejectedByRule[d.Reasons[n-1].Rule]++
			}
		}
		if d.Action != ActionReject {
			if d.FinalPrice > d.CurrentPrice {
				s.Increases++
			} else if d.FinalPrice < d.CurrentPrice {
				s.Decreases++
			}
		}
	}
	return s
}

// PolicyHash is a stable fingerprint of the guardrails in force. Stored on every
// run so a merchant asking "what were my rules in March?" gets an answer that
// does not depend on anyone remembering to write it down.
func PolicyHash(p Policy) string {
	b, err := json.Marshal(p)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:8])
}
