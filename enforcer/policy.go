package enforcer

import "time"

// MarginBasis distinguishes the two things retailers both call "margin".
// Conflating them is a classic pricing bug: at a 40% target, on_price yields
// $16.67 on an $10 item and on_cost yields $14.00.
type MarginBasis string

const (
	// MarginOnPrice is gross margin: (price - cost) / price.
	MarginOnPrice MarginBasis = "on_price"
	// MarginOnCost is markup: (price - cost) / cost.
	MarginOnCost MarginBasis = "on_cost"
)

// MarginFloor is the minimum acceptable margin. A zero MarginFloor is inactive.
type MarginFloor struct {
	Basis MarginBasis `json:"basis"`
	Rate  BasisPoints `json:"rate"`
	// AbsoluteFloor, when non-zero, is a hard price floor applied alongside the
	// rate. Merchants use it for "never below $9.99 regardless of cost".
	AbsoluteFloor Cents `json:"absolute_floor"`
}

func (m MarginFloor) active() bool { return m.Rate > 0 || m.AbsoluteFloor > 0 }

// RoundingMode expresses a price ending as a residue class: the final price
// must satisfy price % Modulus == Residue.
type RoundingMode struct {
	Modulus Cents `json:"modulus"`
	Residue Cents `json:"residue"`
	Enabled bool  `json:"enabled"`
}

var (
	RoundNone        = RoundingMode{}
	RoundCharm99     = RoundingMode{Modulus: 100, Residue: 99, Enabled: true}
	RoundCharm95     = RoundingMode{Modulus: 100, Residue: 95, Enabled: true}
	RoundWholeDollar = RoundingMode{Modulus: 100, Residue: 0, Enabled: true}
	RoundNearestFive = RoundingMode{Modulus: 500, Residue: 0, Enabled: true}
)

// Exclusions name SKUs the engine must never touch, whatever the proposal says.
type Exclusions struct {
	SKUIDs      []string `json:"sku_ids"`
	Tags        []string `json:"tags"`
	Collections []string `json:"collections"`
}

// Velocity caps how often a single SKU may be repriced. Merchants care about
// this more than any other guardrail: customers notice churn.
type Velocity struct {
	MinDaysBetweenChanges int `json:"min_days_between_changes"`
	MaxChangesPerWindow   int `json:"max_changes_per_window"`
	WindowDays            int `json:"window_days"`
}

// Policy is the merchant's complete, versioned set of guardrails. It is data,
// never code: a run pins the policy hash so any past decision can be replayed.
type Policy struct {
	ID      string `json:"id"`
	Version int    `json:"version"`

	MarginFloor MarginFloor `json:"margin_floor"`

	// RespectMAP blocks any price below the SKU's manufacturer-advertised price.
	RespectMAP bool `json:"respect_map"`

	// MaxDecreaseBP / MaxIncreaseBP bound a single cycle's move relative to the
	// current price. Zero means that direction is not permitted at all.
	MaxDecreaseBP BasisPoints `json:"max_decrease_bp"`
	MaxIncreaseBP BasisPoints `json:"max_increase_bp"`

	// HardFloor / HardCeiling are absolute catalog-wide bounds. Zero = inactive.
	HardFloor   Cents `json:"hard_floor"`
	HardCeiling Cents `json:"hard_ceiling"`

	Velocity   Velocity     `json:"velocity"`
	Exclusions Exclusions   `json:"exclusions"`
	Rounding   RoundingMode `json:"rounding"`

	// MinChangeBP is the smallest move worth making. A one-cent markdown costs
	// an API call, a velocity slot, and a line in the merchant's review for no
	// economic value, so below this threshold the engine reports no change at
	// all. It also stops a rounding rule from manufacturing a change on a SKU
	// the estimator said to leave alone.
	MinChangeBP BasisPoints `json:"min_change_bp"`

	// MinConfidenceBP rejects proposals the estimator is not sure about. A tool
	// that declines to guess is more useful than one that always answers.
	MinConfidenceBP BasisPoints `json:"min_confidence_bp"`

	// MaxSKUsChangedBP caps how much of the submitted batch may move in one run.
	// Zero means unlimited. Enforced in DecideBatch, not Decide.
	MaxSKUsChangedBP BasisPoints `json:"max_skus_changed_bp"`
}

// SKUState is everything the engine knows about a variant right now. It is
// supplied by the caller and never fetched here: the engine performs no I/O.
type SKUState struct {
	ID           string   `json:"id"`
	VariantGID   string   `json:"variant_gid"`
	CurrentPrice Cents    `json:"current_price"`
	UnitCost     Cents    `json:"unit_cost"`
	MAPPrice     Cents    `json:"map_price"`
	Tags         []string `json:"tags"`
	Collections  []string `json:"collections"`

	LastPriceChangeAt time.Time `json:"last_price_change_at"`
	ChangesInWindow   int       `json:"changes_in_window"`
	InventoryQuantity int       `json:"inventory_quantity"`
}

// Proposal is what the estimator wants to do. It carries its own confidence so
// the engine can refuse a guess without needing to understand the model.
type Proposal struct {
	SKUID         string      `json:"sku_id"`
	ProposedPrice Cents       `json:"proposed_price"`
	ConfidenceBP  BasisPoints `json:"confidence_bp"`
	Rationale     string      `json:"rationale"`
	Signals       []Signal    `json:"signals"`
}

// Signal is one input that moved the proposed price, carried through to the
// merchant so no change is ever unexplained.
type Signal struct {
	Name        string      `json:"name"`
	ContribuBP  BasisPoints `json:"contribution_bp"`
	Description string      `json:"description"`
}
