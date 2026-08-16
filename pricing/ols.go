package pricing

import (
	"errors"
	"math"
)

// OLS is a fitted ordinary-least-squares regression.
type OLS struct {
	Coef     []float64 // coefficients, one per column of X
	StdErr   []float64 // standard error of each coefficient
	N        int       // observations
	K        int       // parameters, including the intercept
	RSS      float64   // residual sum of squares
	TSS      float64   // total sum of squares
	RSquared float64
	Sigma2   float64 // residual variance, RSS/(N-K)
}

// DF returns the residual degrees of freedom.
func (o OLS) DF() int { return o.N - o.K }

// ConfInterval returns the two-sided interval for coefficient j at the given
// level (0.95 for a 95% interval).
func (o OLS) ConfInterval(j int, level float64) (lo, hi float64) {
	if j < 0 || j >= len(o.Coef) || o.DF() <= 0 {
		return math.NaN(), math.NaN()
	}
	t := TQuantile(1-(1-level)/2, o.DF())
	half := t * o.StdErr[j]
	return o.Coef[j] - half, o.Coef[j] + half
}

var (
	ErrTooFewObservations = errors.New("fewer observations than parameters")
	ErrSingular           = errors.New("design matrix is singular: a regressor has no independent variation")
)

// FitOLS solves y = X*beta by normal equations.
//
// It returns ErrSingular rather than a plausible-looking answer when X'X cannot
// be inverted. That case is not exotic here — it is exactly what a SKU sold at a
// single price produces, and silently returning a number for it would be the
// worst failure this package could have.
func FitOLS(y []float64, x [][]float64) (OLS, error) {
	n := len(y)
	if n == 0 || len(x) != n {
		return OLS{}, ErrTooFewObservations
	}
	k := len(x[0])
	if n <= k {
		return OLS{}, ErrTooFewObservations
	}

	// X'X and X'y
	xtx := make([][]float64, k)
	for i := range xtx {
		xtx[i] = make([]float64, k)
	}
	xty := make([]float64, k)
	for r := 0; r < n; r++ {
		if len(x[r]) != k {
			return OLS{}, ErrTooFewObservations
		}
		for i := 0; i < k; i++ {
			xty[i] += x[r][i] * y[r]
			for j := i; j < k; j++ {
				xtx[i][j] += x[r][i] * x[r][j]
			}
		}
	}
	for i := 0; i < k; i++ {
		for j := 0; j < i; j++ {
			xtx[i][j] = xtx[j][i]
		}
	}

	inv, err := invert(xtx)
	if err != nil {
		return OLS{}, err
	}

	coef := make([]float64, k)
	for i := 0; i < k; i++ {
		for j := 0; j < k; j++ {
			coef[i] += inv[i][j] * xty[j]
		}
	}

	var mean float64
	for _, v := range y {
		mean += v
	}
	mean /= float64(n)

	var rss, tss float64
	for r := 0; r < n; r++ {
		var fit float64
		for i := 0; i < k; i++ {
			fit += x[r][i] * coef[i]
		}
		d := y[r] - fit
		rss += d * d
		dm := y[r] - mean
		tss += dm * dm
	}

	sigma2 := rss / float64(n-k)
	se := make([]float64, k)
	for i := 0; i < k; i++ {
		v := sigma2 * inv[i][i]
		if v < 0 {
			v = 0
		}
		se[i] = math.Sqrt(v)
	}

	r2 := 0.0
	if tss > 0 {
		r2 = 1 - rss/tss
	}

	return OLS{
		Coef: coef, StdErr: se, N: n, K: k,
		RSS: rss, TSS: tss, RSquared: r2, Sigma2: sigma2,
	}, nil
}

// invert performs Gauss-Jordan elimination with partial pivoting.
func invert(a [][]float64) ([][]float64, error) {
	k := len(a)
	m := make([][]float64, k)
	for i := range m {
		m[i] = make([]float64, 2*k)
		copy(m[i], a[i])
		m[i][k+i] = 1
	}

	// Scale the singularity test to the matrix so it means the same thing for
	// prices in cents as for log prices.
	var norm float64
	for i := 0; i < k; i++ {
		for j := 0; j < k; j++ {
			norm = math.Max(norm, math.Abs(a[i][j]))
		}
	}
	tol := 1e-12 * math.Max(norm, 1)

	for col := 0; col < k; col++ {
		pivot := col
		for r := col + 1; r < k; r++ {
			if math.Abs(m[r][col]) > math.Abs(m[pivot][col]) {
				pivot = r
			}
		}
		if math.Abs(m[pivot][col]) < tol {
			return nil, ErrSingular
		}
		m[col], m[pivot] = m[pivot], m[col]

		p := m[col][col]
		for j := 0; j < 2*k; j++ {
			m[col][j] /= p
		}
		for r := 0; r < k; r++ {
			if r == col {
				continue
			}
			f := m[r][col]
			if f == 0 {
				continue
			}
			for j := 0; j < 2*k; j++ {
				m[r][j] -= f * m[col][j]
			}
		}
	}

	out := make([][]float64, k)
	for i := range out {
		out[i] = make([]float64, k)
		copy(out[i], m[i][k:])
	}
	return out, nil
}
