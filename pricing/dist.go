package pricing

import "math"

// NormalQuantile returns the inverse standard normal CDF using Acklam's
// rational approximation, refined by one Halley step against erfc. Accurate to
// roughly 1e-15 across the whole range.
//
// A confidence interval is only worth printing if its width is right, so the
// quantiles behind it are computed properly rather than hardcoded at 1.96.
func NormalQuantile(p float64) float64 {
	if p <= 0 || p >= 1 || math.IsNaN(p) {
		return math.NaN()
	}

	a := [6]float64{-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
		1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00}
	b := [5]float64{-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
		6.680131188771972e+01, -1.328068155288572e+01}
	c := [6]float64{-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
		-2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00}
	d := [4]float64{7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
		3.754408661907416e+00}

	const pLow = 0.02425
	var x float64

	switch {
	case p < pLow:
		q := math.Sqrt(-2 * math.Log(p))
		x = (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q + c[5]) /
			((((d[0]*q+d[1])*q+d[2])*q+d[3])*q + 1)
	case p <= 1-pLow:
		q := p - 0.5
		r := q * q
		x = (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r + a[5]) * q /
			(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r + 1)
	default:
		q := math.Sqrt(-2 * math.Log(1-p))
		x = -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q + c[5]) /
			((((d[0]*q+d[1])*q+d[2])*q+d[3])*q + 1)
	}

	// One Halley refinement against the true CDF.
	e := 0.5*math.Erfc(-x/math.Sqrt2) - p
	u := e * math.Sqrt(2*math.Pi) * math.Exp(x*x/2)
	return x - u/(1+x*u/2)
}

// TQuantile returns the inverse Student-t CDF via the Cornish-Fisher expansion.
//
// The expansion degrades for very small degrees of freedom, which is fine here:
// the estimator refuses to report at all below MinObservations, so df is never
// small enough for the approximation to matter. TestTQuantileMatchesTables pins
// it against published values so that assumption is checked rather than assumed.
func TQuantile(p float64, df int) float64 {
	if df <= 0 {
		return math.NaN()
	}
	if df > 5000 {
		return NormalQuantile(p)
	}

	z := NormalQuantile(p)
	if math.IsNaN(z) {
		return math.NaN()
	}

	n := float64(df)
	z2 := z * z
	z3 := z2 * z
	z5 := z3 * z2
	z7 := z5 * z2
	z9 := z7 * z2

	t := z
	t += (z3 + z) / (4 * n)
	t += (5*z5 + 16*z3 + 3*z) / (96 * n * n)
	t += (3*z7 + 19*z5 + 17*z3 - 15*z) / (384 * n * n * n)
	t += (79*z9 + 776*z7 + 1482*z5 - 1920*z3 - 945*z) / (92160 * n * n * n * n)
	return t
}
