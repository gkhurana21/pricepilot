package enforcer

import (
	"math/rand"
	"testing"
)

// FuzzDecide attacks the six guarantees in the package doc with arbitrary
// input. The engine performs no I/O and reads no clock, so a failing input is
// a complete, permanently reproducible bug report — Go writes it to
// testdata/fuzz/ and it becomes a regression test forever.
//
//	go test -fuzz=FuzzDecide -fuzztime=60s
func FuzzDecide(f *testing.F) {
	// Seeds are the table-test situations, so the fuzzer starts from realistic
	// pricing rather than spending its budget rediscovering that prices are
	// positive.
	f.Add([]byte{})
	f.Add([]byte{0x00})
	f.Add(make([]byte, 64))
	f.Add([]byte{
		0x02, 0x00, 0x00, 0x0f, 0xa0, 0x01, 0x00, 0x00, 0x00, 0x00,
		0x05, 0x00, 0x00, 0x07, 0xd0, 0x05, 0x00, 0x00, 0x07, 0xd0,
	})
	for seed := int64(1); seed <= 12; seed++ {
		buf := make([]byte, 96)
		rand.New(rand.NewSource(seed)).Read(buf)
		f.Add(buf)
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		pol, state, prop, now := decodeScenario(data)

		got := Decide(pol, state, prop, now)
		checkInvariants(t, pol, state, prop, now, got)

		// The engine is pure, so an identical call must produce an identical
		// result. Any drift here means hidden state crept in.
		again := Decide(pol, state, prop, now)
		if got.Action != again.Action || got.FinalPrice != again.FinalPrice {
			t.Fatalf("invariant violated: not deterministic — %q/%s then %q/%s",
				got.Action, got.FinalPrice, again.Action, again.FinalPrice)
		}
	})
}

// FuzzRoundWithin isolates the rule most likely to silently undo the others.
// Rounding is applied last, so a bug here reaches the catalog having passed
// every earlier check.
func FuzzRoundWithin(f *testing.F) {
	f.Add(int64(1002), int64(1000), int64(1200), int64(100), int64(99))
	f.Add(int64(1001), int64(1000), int64(1002), int64(100), int64(99))
	f.Add(int64(500), int64(500), int64(500), int64(100), int64(0))
	f.Add(int64(0), int64(0), int64(0), int64(1), int64(0))

	f.Fuzz(func(t *testing.T, target, lo, hi, modulus, residue int64) {
		if modulus <= 0 || modulus > int64(MaxPrice) {
			t.Skip()
		}
		if residue < 0 || residue >= modulus {
			t.Skip()
		}
		if lo > hi {
			t.Skip()
		}

		mode := RoundingMode{Enabled: true, Modulus: Cents(modulus), Residue: Cents(residue)}
		got, ok := roundWithin(Cents(target), Cents(lo), Cents(hi), mode)

		if !ok {
			// Standing down must be honest: it may only happen when the
			// interval genuinely contains no value matching the pattern.
			first := patternCeil(Cents(lo), Cents(modulus), Cents(residue))
			if first >= Cents(lo) && first <= Cents(hi) {
				t.Fatalf("rounding stood down at [%s, %s] but %s matches the pattern",
					Cents(lo), Cents(hi), first)
			}
			if got != Cents(target) {
				t.Fatalf("rounding stood down but still altered %s to %s", Cents(target), got)
			}
			return
		}

		// A rounded price must satisfy the pattern...
		if ((int64(got)-residue)%modulus+modulus)%modulus != 0 {
			t.Fatalf("rounded %s does not match pattern (mod %d, residue %d)", got, modulus, residue)
		}
		// ...and must never escape the interval the bounds allowed. This is the
		// guarantee that stops rounding from undoing a margin floor.
		if got < Cents(lo) || got > Cents(hi) {
			t.Fatalf("rounded %s escaped the admissible range [%s, %s]", got, Cents(lo), Cents(hi))
		}
		// ...and must be the nearest such value, not merely a valid one.
		below := patternFloor(Cents(target), Cents(modulus), Cents(residue))
		above := patternCeil(Cents(target), Cents(modulus), Cents(residue))
		bestDist := Cents(-1)
		for _, cand := range []Cents{below, above} {
			if cand < Cents(lo) || cand > Cents(hi) {
				continue
			}
			d := cand - Cents(target)
			if d < 0 {
				d = -d
			}
			if bestDist < 0 || d < bestDist {
				bestDist = d
			}
		}
		if bestDist >= 0 {
			gotDist := got - Cents(target)
			if gotDist < 0 {
				gotDist = -gotDist
			}
			if gotDist > bestDist {
				t.Fatalf("rounded %s is not the nearest permitted value to %s in [%s, %s]",
					got, Cents(target), Cents(lo), Cents(hi))
			}
		}
	})
}
