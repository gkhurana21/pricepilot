package enforcer

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
	_ "time/tzdata" // so the zone loads on any platform
)

// TestVelocityDoesNotDependOnTheServerTimeZone proves cooldown arithmetic is
// done in UTC. A timestamp decoded from JSON with an offset that matches the
// server's zone is stored as time.Local, and AddDate on a Local time moves the
// wall clock, so across a daylight-saving change "N days" is 23 or 25 hours
// off from N*24h. The same instant written in UTC must give the same decision.
func TestVelocityDoesNotDependOnTheServerTimeZone(t *testing.T) {
	toronto, err := time.LoadLocation("America/Toronto")
	if err != nil {
		t.Fatal(err)
	}
	saved := time.Local
	time.Local = toronto
	t.Cleanup(func() { time.Local = saved })

	// DST ended in Toronto at 02:00 local on 2026-11-01.
	cases := []struct {
		name         string
		lastChange   string // as written by a Toronto-based caller
		lastChangeZ  string // the identical instant in UTC
		now          string
		nowZ         string
		days         int
		wantBlocked  bool
		wantNextDate string
	}{
		{
			name:       "cooldown straddling the fall-back, now one hour after the UTC deadline",
			lastChange: "2026-10-31T23:30:00-04:00", lastChangeZ: "2026-11-01T03:30:00Z",
			now: "2026-11-03T23:00:00-05:00", nowZ: "2026-11-04T04:00:00Z",
			days: 3, wantBlocked: false,
		},
		{
			name:       "cooldown straddling the fall-back, now thirty minutes before the UTC deadline",
			lastChange: "2026-10-31T23:30:00-04:00", lastChangeZ: "2026-11-01T03:30:00Z",
			now: "2026-11-03T22:00:00-05:00", nowZ: "2026-11-04T03:00:00Z",
			days: 3, wantBlocked: true, wantNextDate: "2026-11-04",
		},
		{
			name:       "cooldown ending before the fall-back is unaffected",
			lastChange: "2026-10-20T08:00:00-04:00", lastChangeZ: "2026-10-20T12:00:00Z",
			now: "2026-10-23T07:59:00-04:00", nowZ: "2026-10-23T11:59:00Z",
			days: 3, wantBlocked: true, wantNextDate: "2026-10-23",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			decode := func(last, now string) (SKUState, time.Time) {
				var s SKUState
				raw := `{"id":"sku_1","current_price":1000,"unit_cost":200,"last_price_change_at":"` + last + `"}`
				if err := json.Unmarshal([]byte(raw), &s); err != nil {
					t.Fatal(err)
				}
				var n time.Time
				if err := json.Unmarshal([]byte(`"`+now+`"`), &n); err != nil {
					t.Fatal(err)
				}
				return s, n
			}
			local, nowLocal := decode(tc.lastChange, tc.now)
			if local.LastPriceChangeAt.Location() != time.Local {
				t.Fatalf("test setup: decoded timestamp is in %v, want time.Local", local.LastPriceChangeAt.Location())
			}
			utc, nowUTC := decode(tc.lastChangeZ, tc.nowZ)
			if !local.LastPriceChangeAt.Equal(utc.LastPriceChangeAt) || !nowLocal.Equal(nowUTC) {
				t.Fatal("test setup: the two spellings are not the same instants")
			}

			pol := basePolicy()
			pol.Velocity = Velocity{MinDaysBetweenChanges: tc.days}
			prop := propose(950)

			gotLocal := Decide(pol, local, prop, nowLocal)
			gotUTC := Decide(pol, utc, prop, nowUTC)
			checkInvariants(t, pol, local, prop, nowLocal, gotLocal)

			if (gotUTC.Action == ActionReject) != tc.wantBlocked {
				t.Fatalf("UTC reference decision blocked=%v, want %v: %s",
					gotUTC.Action == ActionReject, tc.wantBlocked, formatReasons(gotUTC))
			}
			if gotLocal.Action != gotUTC.Action || gotLocal.FinalPrice != gotUTC.FinalPrice {
				t.Errorf("same instants, different decision: local %q/%s vs UTC %q/%s\nlocal: %s\nutc: %s",
					gotLocal.Action, gotLocal.FinalPrice, gotUTC.Action, gotUTC.FinalPrice,
					formatReasons(gotLocal), formatReasons(gotUTC))
			}
			if !reflect.DeepEqual(gotLocal.Reasons, gotUTC.Reasons) {
				t.Errorf("reasons differ for the same instants\nlocal: %s\nutc: %s",
					formatReasons(gotLocal), formatReasons(gotUTC))
			}
		})
	}
}
