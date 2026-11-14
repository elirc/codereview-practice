// Package money represents US dollar amounts as integer cents.
package money

import (
	"errors"
	"strconv"
	"strings"
)

// Cents is an amount of US dollars in cents.
type Cents int64

// Errors returned by Parse and ParsePositive.
var (
	ErrSyntax      = errors.New("must be a number with at most two decimal places, like 1250.00")
	ErrNotPositive = errors.New("must be greater than zero")
	ErrTooLarge    = errors.New("is too large")
)

// maxWholeDigits keeps parsed amounts far below the range where proration and
// percentage arithmetic could overflow int64.
const maxWholeDigits = 9

// Parse converts a plain decimal string such as "1000", "1000.5" or "0.25"
// into cents. Signs, thousands separators, exponents and more than two
// decimal places are rejected.
func Parse(s string) (Cents, error) {
	s = strings.TrimSpace(s)
	whole, frac, hasDot := strings.Cut(s, ".")
	if !isDigits(whole) || (hasDot && (!isDigits(frac) || len(frac) > 2)) {
		return 0, ErrSyntax
	}
	whole = strings.TrimLeft(whole, "0")
	if len(whole) > maxWholeDigits {
		return 0, ErrTooLarge
	}

	var c int64
	for i := 0; i < len(whole); i++ {
		c = c*10 + int64(whole[i]-'0')
	}
	c *= 100
	if len(frac) >= 1 {
		c += int64(frac[0]-'0') * 10
	}
	if len(frac) == 2 {
		c += int64(frac[1] - '0')
	}
	return Cents(c), nil
}

// ParsePositive is Parse restricted to amounts greater than zero.
func ParsePositive(s string) (Cents, error) {
	c, err := Parse(s)
	if err != nil {
		return 0, err
	}
	if c <= 0 {
		return 0, ErrNotPositive
	}
	return c, nil
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// String formats c for display, e.g. "$1,234.56" or "-$12.00".
func (c Cents) String() string {
	sign := ""
	if c < 0 {
		sign = "-"
	}
	whole, frac := split(c)
	digits := strconv.FormatInt(whole, 10)
	var b strings.Builder
	for i := 0; i < len(digits); i++ {
		if i > 0 && (len(digits)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteByte(digits[i])
	}
	return sign + "$" + b.String() + "." + twoDigits(frac)
}

// Plain formats c without currency symbol or separators, e.g. "1234.56",
// which Parse accepts back for non-negative amounts.
func (c Cents) Plain() string {
	sign := ""
	if c < 0 {
		sign = "-"
	}
	whole, frac := split(c)
	return sign + strconv.FormatInt(whole, 10) + "." + twoDigits(frac)
}

func split(c Cents) (whole, frac int64) {
	v := int64(c)
	if v < 0 {
		v = -v
	}
	return v / 100, v % 100
}

func twoDigits(v int64) string {
	if v < 10 {
		return "0" + strconv.FormatInt(v, 10)
	}
	return strconv.FormatInt(v, 10)
}

// DivRoundHalfUp returns n/d rounded half up. It requires n >= 0 and d > 0.
func DivRoundHalfUp(n, d int64) int64 {
	return (n*2 + d) / (2 * d)
}

// Prorate returns amount × num / den rounded half up to the cent.
func Prorate(amount Cents, num, den int64) Cents {
	return Cents(DivRoundHalfUp(int64(amount)*num, den))
}

// BasisPoints returns bps basis points of amount, rounded half up.
func BasisPoints(amount Cents, bps int64) Cents {
	return Cents(DivRoundHalfUp(int64(amount)*bps, 10000))
}
