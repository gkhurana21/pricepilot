package enforcer

// Action is the engine's verdict. There is no fourth option and no "maybe":
// every proposal leaves the engine approved, clamped, or rejected.
type Action string

const (
	// ActionApprove: the proposed price cleared every rule untouched.
	ActionApprove Action = "approve"
	// ActionClamp: the price was moved to the nearest compliant value.
	ActionClamp Action = "clamp"
	// ActionReject: no compliant price exists, or a gate rule blocked the SKU.
	ActionReject Action = "reject"
)

// RuleID identifies which guardrail produced a reason. Every non-approval names
// at least one, so a merchant can always answer "why did this not apply?".
type RuleID string

const (
	RuleExcluded      RuleID = "excluded"
	RuleConfidence    RuleID = "min_confidence"
	RuleVelocityDays  RuleID = "velocity_min_days"
	RuleVelocityCount RuleID = "velocity_max_changes"
	RuleMarginFloor   RuleID = "margin_floor"
	RuleMAP           RuleID = "map"
	RuleHardFloor     RuleID = "hard_floor"
	RuleHardCeiling   RuleID = "hard_ceiling"
	RuleMaxDecrease   RuleID = "max_decrease"
	RuleMaxIncrease   RuleID = "max_increase"
	// RuleProposalDirection is the bound a proposal's own direction imposes: a
	// cut may not land above the current price, a rise may not land below it.
	RuleProposalDirection RuleID = "proposal_direction"
	RuleRounding          RuleID = "rounding"
	RuleInfeasible        RuleID = "infeasible_bounds"
	RuleNoChange          RuleID = "no_change"
	RuleMinChange         RuleID = "min_change"
	RuleInvalidInput      RuleID = "invalid_input"
	RuleBatchBudget       RuleID = "batch_change_budget"
)

// Effect describes what a rule did, so the UI can style a blocking rule
// differently from one that merely nudged the price.
type Effect string

const (
	EffectBlocked Effect = "blocked"
	EffectBound   Effect = "bound"
	EffectClamped Effect = "clamped"
	EffectInfo    Effect = "info"
)

// Reason is one rule's contribution to the verdict.
type Reason struct {
	Rule    RuleID `json:"rule"`
	Effect  Effect `json:"effect"`
	Message string `json:"message"`
}

// Decision is the complete, replayable outcome for one proposal.
type Decision struct {
	SKUID  string `json:"sku_id"`
	Action Action `json:"action"`

	CurrentPrice  Cents `json:"current_price"`
	ProposedPrice Cents `json:"proposed_price"`
	// FinalPrice is the price to write. It is zero if and only if Action is
	// ActionReject — an invariant the fuzzer checks on every input.
	FinalPrice Cents `json:"final_price"`

	// LowerBound / UpperBound are the admissible interval the rules produced.
	// Surfaced so the merchant can see how much room the policy actually left.
	LowerBound Cents `json:"lower_bound"`
	UpperBound Cents `json:"upper_bound"`

	DeltaBP  BasisPoints `json:"delta_bp"`
	MarginBP BasisPoints `json:"margin_bp"`

	Reasons []Reason `json:"reasons"`
	Signals []Signal `json:"signals"`
}

func (d *Decision) add(rule RuleID, effect Effect, msg string) {
	d.Reasons = append(d.Reasons, Reason{Rule: rule, Effect: effect, Message: msg})
}

// Blocked reports whether the decision names a gate rule rather than simply
// having nowhere to move.
func (d Decision) Blocked() bool {
	for _, r := range d.Reasons {
		if r.Effect == EffectBlocked {
			return true
		}
	}
	return false
}

// BoundByPolicy reports whether a guardrail actually overrode the proposal, as
// opposed to the price merely being rounded to a permitted ending.
//
// Both outcomes are ActionClamp, but they mean very different things to a
// merchant: one says "your policy disagreed with the model", the other says
// "we tidied the ending". With a rounding rule enabled almost every proposal is
// technically clamped, so without this distinction the action alone stops
// carrying information.
func (d Decision) BoundByPolicy() bool {
	for _, r := range d.Reasons {
		if r.Effect == EffectClamped && r.Rule != RuleRounding {
			return true
		}
	}
	return false
}
