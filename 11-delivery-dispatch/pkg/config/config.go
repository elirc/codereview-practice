// Package config reads typed settings from the environment and reports every
// missing or invalid value at once.
package config

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// LookupFunc returns the value of an environment variable and whether it is set.
type LookupFunc func(key string) (string, bool)

// Loader reads values through a LookupFunc and collects errors.
type Loader struct {
	lookup LookupFunc
	errs   []error
}

// New returns a Loader backed by lookup (usually os.LookupEnv).
func New(lookup LookupFunc) *Loader {
	return &Loader{lookup: lookup}
}

func (l *Loader) raw(key string) (string, bool) {
	v, ok := l.lookup(key)
	if !ok {
		return "", false
	}
	v = strings.TrimSpace(v)
	return v, v != ""
}

func (l *Loader) fail(key, format string, args ...any) {
	l.errs = append(l.errs, fmt.Errorf("%s: %s", key, fmt.Sprintf(format, args...)))
}

// Required returns the value of key, recording an error when it is unset or empty.
func (l *Loader) Required(key string) string {
	v, ok := l.raw(key)
	if !ok {
		l.fail(key, "is required")
	}
	return v
}

// String returns the value of key or def when it is unset.
func (l *Loader) String(key, def string) string {
	if v, ok := l.raw(key); ok {
		return v
	}
	return def
}

// Int64 returns key parsed as an integer in [lo, hi], or def when unset.
func (l *Loader) Int64(key string, def, lo, hi int64) int64 {
	v, ok := l.raw(key)
	if !ok {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		l.fail(key, "must be an integer")
		return def
	}
	if n < lo || n > hi {
		l.fail(key, "must be between %d and %d", lo, hi)
		return def
	}
	return n
}

// Duration returns key parsed with time.ParseDuration, or def when unset.
// The value must be positive.
func (l *Loader) Duration(key string, def time.Duration) time.Duration {
	v, ok := l.raw(key)
	if !ok {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		l.fail(key, "must be a duration such as 30s or 5m")
		return def
	}
	if d <= 0 {
		l.fail(key, "must be positive")
		return def
	}
	return d
}

// Bool returns key parsed with strconv.ParseBool, or def when unset.
func (l *Loader) Bool(key string, def bool) bool {
	v, ok := l.raw(key)
	if !ok {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		l.fail(key, "must be true or false")
		return def
	}
	return b
}

// Check records an error for key when ok is false.
func (l *Loader) Check(ok bool, key, message string) {
	if !ok {
		l.fail(key, "%s", message)
	}
}

// Err returns all recorded problems joined, or nil.
func (l *Loader) Err() error {
	if len(l.errs) == 0 {
		return nil
	}
	return fmt.Errorf("invalid configuration: %w", errors.Join(l.errs...))
}

// Common holds the settings every service reads.
type Common struct {
	JWTSecret    string
	NATSURL      string
	Currency     string
	LoopsEnabled bool
	LogLevel     string
}

// LoadCommon reads the shared settings into a Common value.
func LoadCommon(l *Loader) Common {
	c := Common{
		JWTSecret:    l.Required("AUTH_JWT_SECRET"),
		NATSURL:      l.String("NATS_URL", "nats://localhost:6393"),
		Currency:     strings.ToUpper(l.String("APP_CURRENCY", "USD")),
		LoopsEnabled: l.Bool("LOOPS_ENABLED", true),
		LogLevel:     l.String("LOG_LEVEL", "info"),
	}
	l.Check(c.JWTSecret == "" || len(c.JWTSecret) >= 32, "AUTH_JWT_SECRET", "must be at least 32 bytes")
	l.Check(len(c.Currency) == 3, "APP_CURRENCY", "must be a three-letter ISO-4217 code")
	return c
}
