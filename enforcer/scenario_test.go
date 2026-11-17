package enforcer

import "time"

// scenario decodes an arbitrary byte string into a complete pricing situation.
//
// Both the fuzzer and the randomized property test build inputs through this
// one decoder, so they explore the same space and a fuzz failure can always be
// reproduced by the property test and vice versa.
//
// The ranges deliberately include invalid values — negative rates, impossible
// margin floors, prices past MaxPrice. Proving the engine rejects nonsense is
// as important as proving it handles sense, because a guardrail that fails open
// on bad input protects nobody.
type reader struct {
	b []byte
	i int
}

func (r *reader) byteAt() byte {
	if r.i >= len(r.b) {
		return 0
	}
	v := r.b[r.i]
	r.i++
	return v
}

func (r *reader) uint32() uint32 {
	var v uint32
	for k := 0; k < 4; k++ {
		v = v<<8 | uint32(r.byteAt())
	}
	return v
}

// intn returns a value in [0, n). Uses uint32 so the distribution is stable
// across architectures and a corpus entry means the same thing everywhere.
func (r *reader) intn(n int64) int64 {
	if n <= 0 {
		return 0
	}
	return int64(r.uint32()) % n
}

func (r *reader) bool() bool { return r.byteAt()&1 == 1 }

// money returns a mostly-plausible amount, with a tail of extreme and invalid
// values so the validation path gets exercised too.
func (r *reader) money() Cents {
	switch r.byteAt() % 16 {
	case 0:
		return 0
	case 1:
		return Cents(-r.intn(100_000))
	case 2:
		return MaxPrice + Cents(r.intn(1000))
	case 3:
		return Cents(r.intn(int64(MaxPrice)))
	default:
		return Cents(r.intn(500_000)) // up to $5,000, the realistic bulk
	}
}

func (r *reader) bp(max int64) BasisPoints {
	switch r.byteAt() % 12 {
	case 0:
		return BasisPoints(-r.intn(5000))
	case 1:
		return BasisPoints(max + r.intn(5000))
	default:
		return BasisPoints(r.intn(max + 1))
	}
}

// between returns a value in [lo, hi].
func (r *reader) between(lo, hi int64) int64 {
	if hi <= lo {
		return lo
	}
	return lo + r.intn(hi-lo+1)
}

var fuzzTags = []string{"", "clearance", "do-not-reprice", "new", "bundle"}

// decodeScenario builds a scenario in one of three modes.
//
// Below-floor mode starts from a realistic scenario and then makes the current
// price violate a lower bound (a margin floor above the price, or MAP above
// it). Real catalogs get there when costs rise or a supplier raises MAP, and
// realisticScenario cannot reach it because it derives cost and floors from
// the price. About one scenario in sixteen is below-floor.
//
// Hostile mode produces nonsense — negative rates, impossible margin floors,
// contradictory bounds — and proves the engine refuses to emit a price.
// Realistic mode produces coherent merchant configurations and proves the
// engine emits *correct* prices under every guardrail.
//
// The split exists because a purely hostile generator rejects ~99.9% of inputs.
// Every invariant still passes, but the ones that matter most — margin floors,
// MAP, per-cycle caps — are only reachable on the approve and clamp paths, so
// a hostile-only corpus would look thorough while barely testing them.
func decodeScenario(data []byte) (Policy, SKUState, Proposal, time.Time) {
	r := &reader{b: data}
	switch first := r.byteAt(); {
	case first%4 == 0:
		return hostileScenario(r)
	case first%16 == 1:
		return belowFloorScenario(r)
	}
	return realisticScenario(r)
}

// belowFloorID marks scenarios from belowFloorScenario so a test can count them.
const belowFloorID = "below_floor"

// belowFloorScenario is a realistic scenario whose current price is already
// below an active lower bound. The proposal is a cut, a rise, or exactly the
// current price, so each direction meets the bound.
func belowFloorScenario(r *reader) (Policy, SKUState, Proposal, time.Time) {
	pol, state, prop, now := realisticScenario(r)
	pol.ID = belowFloorID
	cur := int64(state.CurrentPrice)

	switch r.byteAt() % 4 {
	case 0: // absolute margin floor above the price
		pol.MarginFloor = MarginFloor{AbsoluteFloor: Cents(cur + r.between(1, cur/2+1))}
	case 1: // cost close to price with a gross margin floor: floor > 1.43 * cost > price
		state.UnitCost = Cents(cur * r.between(80, 99) / 100)
		pol.MarginFloor = MarginFloor{Basis: MarginOnPrice, Rate: BasisPoints(r.between(3000, 4500))}
	case 2: // markup floor: floor >= 1.5 * cost > price
		state.UnitCost = Cents(cur * r.between(70, 99) / 100)
		pol.MarginFloor = MarginFloor{Basis: MarginOnCost, Rate: BasisPoints(r.between(5000, 8000))}
	case 3: // MAP above the price
		pol.RespectMAP = true
		state.MAPPrice = Cents(cur * r.between(101, 130) / 100)
	}

	switch r.byteAt() % 3 {
	case 0:
		prop.ProposedPrice = state.CurrentPrice
	case 1:
		prop.ProposedPrice = Cents(cur * r.between(40, 99) / 100)
	}
	if prop.ProposedPrice <= 0 {
		prop.ProposedPrice = 1
	}
	return pol, state, prop, now
}

// realisticScenario derives every field from the ones before it, the way a real
// catalog does: cost is a fraction of price, MAP sits below price, the proposal
// is a plausible move from the current price. Bounds are wide enough that the
// price-producing path is reached often and narrow enough that clamps happen.
func realisticScenario(r *reader) (Policy, SKUState, Proposal, time.Time) {
	current := Cents(r.between(500, 50_000)) // $5.00 - $500.00
	costPct := r.between(15, 55)
	cost := Cents(int64(current) * costPct / 100)

	pol := Policy{
		ID:            "realistic",
		Version:       1,
		MaxDecreaseBP: BasisPoints(r.between(300, 3000)),
		MaxIncreaseBP: BasisPoints(r.between(300, 3000)),
	}

	switch r.byteAt() % 4 {
	case 0:
		pol.MarginFloor = MarginFloor{Basis: MarginOnPrice, Rate: BasisPoints(r.between(0, 4500))}
	case 1:
		pol.MarginFloor = MarginFloor{Basis: MarginOnCost, Rate: BasisPoints(r.between(0, 8000))}
	case 2:
		pol.MarginFloor = MarginFloor{AbsoluteFloor: Cents(r.between(100, int64(current)))}
	}

	state := SKUState{
		ID:           "sku_real",
		VariantGID:   "gid://shopify/ProductVariant/1",
		CurrentPrice: current,
		UnitCost:     cost,
		Tags:         []string{fuzzTags[r.intn(int64(len(fuzzTags)))]},
		Collections:  []string{"main"},
	}

	if r.byteAt()%3 == 0 {
		pol.RespectMAP = true
		state.MAPPrice = Cents(int64(current) * r.between(50, 95) / 100)
	}

	switch r.byteAt() % 5 {
	case 0:
		pol.HardFloor = Cents(int64(current) * r.between(30, 90) / 100)
	case 1:
		pol.HardCeiling = Cents(int64(current) * r.between(105, 200) / 100)
	}

	switch r.byteAt() % 6 {
	case 0:
		pol.Rounding = RoundCharm99
	case 1:
		pol.Rounding = RoundCharm95
	case 2:
		pol.Rounding = RoundWholeDollar
	case 3:
		pol.Rounding = RoundNearestFive
	}

	// Velocity is usually permissive; a always-blocking cooldown would hide
	// every downstream rule behind a single gate.
	if r.byteAt()%4 == 0 {
		pol.Velocity = Velocity{
			MinDaysBetweenChanges: int(r.between(0, 30)),
			MaxChangesPerWindow:   int(r.between(1, 4)),
			WindowDays:            int(r.between(7, 90)),
		}
		state.ChangesInWindow = int(r.between(0, 4))
		state.LastPriceChangeAt = testNow.AddDate(0, 0, -int(r.between(0, 120)))
	}

	if r.byteAt()%8 == 0 {
		pol.Exclusions.Tags = []string{fuzzTags[r.intn(int64(len(fuzzTags)))]}
	}

	pol.MinChangeBP = BasisPoints(r.between(0, 300))
	pol.MinConfidenceBP = BasisPoints(r.between(0, 7000))
	pol.MaxSKUsChangedBP = BasisPoints(r.between(0, 10000))

	// The proposal deliberately overshoots the caps much of the time, so clamps
	// and infeasible intervals are both routinely exercised.
	prop := Proposal{
		SKUID:         "sku_real",
		ProposedPrice: Cents(int64(current) * r.between(40, 170) / 100),
		ConfidenceBP:  BasisPoints(r.between(0, 10000)),
		Rationale:     "elasticity estimate",
		Signals: []Signal{
			{Name: "elasticity", ContribuBP: BasisPoints(r.between(-2000, 2000))},
			{Name: "inventory_age", ContribuBP: BasisPoints(r.between(-1000, 1000))},
		},
	}
	if prop.ProposedPrice <= 0 {
		prop.ProposedPrice = 1
	}

	return pol, state, prop, testNow
}

// hostileScenario is the original adversarial generator: every field may be out
// of range, contradictory, or nonsensical.
func hostileScenario(r *reader) (Policy, SKUState, Proposal, time.Time) {
	basis := MarginOnPrice
	switch r.byteAt() % 8 {
	case 0:
		basis = MarginOnCost
	case 1:
		basis = MarginBasis("nonsense")
	}

	pol := Policy{
		ID:      "hostile",
		Version: 1,
		MarginFloor: MarginFloor{
			Basis:         basis,
			Rate:          r.bp(9000),
			AbsoluteFloor: r.money(),
		},
		RespectMAP:       r.bool(),
		MaxDecreaseBP:    r.bp(10000),
		MaxIncreaseBP:    r.bp(10000),
		HardFloor:        r.money(),
		HardCeiling:      r.money(),
		MinChangeBP:      r.bp(10000),
		MinConfidenceBP:  r.bp(10000),
		MaxSKUsChangedBP: r.bp(10000),
		Velocity: Velocity{
			MinDaysBetweenChanges: int(r.intn(60)) - 5,
			MaxChangesPerWindow:   int(r.intn(6)) - 1,
			WindowDays:            int(r.intn(90)) - 5,
		},
	}

	if r.bool() {
		pol.Rounding = RoundingMode{
			Enabled: true,
			Modulus: Cents(r.intn(1000) - 2),
			Residue: Cents(r.intn(1000) - 2),
		}
	}

	switch r.byteAt() % 6 {
	case 0:
		pol.Exclusions.Tags = []string{fuzzTags[r.intn(int64(len(fuzzTags)))]}
	case 1:
		pol.Exclusions.SKUIDs = []string{"sku_fuzz"}
	case 2:
		pol.Exclusions.Collections = []string{"archive"}
	}

	state := SKUState{
		ID:              "sku_fuzz",
		VariantGID:      "gid://shopify/ProductVariant/1",
		CurrentPrice:    r.money(),
		UnitCost:        r.money(),
		MAPPrice:        r.money(),
		Tags:            []string{fuzzTags[r.intn(int64(len(fuzzTags)))]},
		Collections:     []string{"main"},
		ChangesInWindow: int(r.intn(6)) - 1,
	}

	if r.bool() {
		state.LastPriceChangeAt = testNow.AddDate(0, 0, -int(r.intn(120)))
	}

	prop := Proposal{
		SKUID:         "sku_fuzz",
		ProposedPrice: r.money(),
		ConfidenceBP:  r.bp(10000),
		Rationale:     "fuzz",
	}

	return pol, state, prop, testNow
}
