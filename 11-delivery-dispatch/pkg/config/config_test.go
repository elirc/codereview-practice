package config

import (
	"strings"
	"testing"
	"time"
)

func lookupFrom(m map[string]string) LookupFunc {
	return func(k string) (string, bool) {
		v, ok := m[k]
		return v, ok
	}
}

func TestLoaderReadsValuesAndDefaults(t *testing.T) {
	l := New(lookupFrom(map[string]string{
		"NAME":    "orders",
		"COUNT":   "7",
		"TIMEOUT": "90s",
		"ENABLED": "false",
	}))
	if got := l.Required("NAME"); got != "orders" {
		t.Fatalf("Required = %q", got)
	}
	if got := l.Int64("COUNT", 1, 0, 10); got != 7 {
		t.Fatalf("Int64 = %d", got)
	}
	if got := l.Int64("MISSING", 3, 0, 10); got != 3 {
		t.Fatalf("Int64 default = %d", got)
	}
	if got := l.Duration("TIMEOUT", time.Second); got != 90*time.Second {
		t.Fatalf("Duration = %v", got)
	}
	if got := l.Bool("ENABLED", true); got {
		t.Fatal("Bool = true")
	}
	if err := l.Err(); err != nil {
		t.Fatal(err)
	}
}

func TestLoaderReportsEveryProblem(t *testing.T) {
	l := New(lookupFrom(map[string]string{
		"COUNT":   "eleven",
		"RANGE":   "50",
		"TIMEOUT": "-1s",
	}))
	l.Required("SECRET")
	l.Int64("COUNT", 1, 0, 10)
	l.Int64("RANGE", 1, 0, 10)
	l.Duration("TIMEOUT", time.Second)
	err := l.Err()
	if err == nil {
		t.Fatal("expected errors")
	}
	for _, key := range []string{"SECRET", "COUNT", "RANGE", "TIMEOUT"} {
		if !strings.Contains(err.Error(), key) {
			t.Errorf("error does not mention %s: %v", key, err)
		}
	}
}

func TestLoadCommonValidatesSecretLength(t *testing.T) {
	l := New(lookupFrom(map[string]string{"AUTH_JWT_SECRET": "short"}))
	LoadCommon(l)
	if l.Err() == nil {
		t.Fatal("expected short secret to be rejected")
	}
}
