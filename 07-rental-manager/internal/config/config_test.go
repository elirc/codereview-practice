package config

import (
	"log/slog"
	"strings"
	"testing"
	_ "time/tzdata"
)

func envFrom(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(envFrom(map[string]string{
		"DATABASE_URL": "postgres://u:p@localhost:5457/rentmgr",
	}))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.HTTPAddr != ":8087" {
		t.Errorf("HTTPAddr = %q", cfg.HTTPAddr)
	}
	if cfg.Env != EnvDevelopment || cfg.Production() {
		t.Errorf("Env = %q", cfg.Env)
	}
	if cfg.Location.String() != "America/Chicago" {
		t.Errorf("Location = %s", cfg.Location)
	}
	if cfg.LogLevel != slog.LevelInfo {
		t.Errorf("LogLevel = %v", cfg.LogLevel)
	}
}

func TestLoadRejectsInvalidValues(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"missing database url", map[string]string{}, "DATABASE_URL is required"},
		{"wrong scheme", map[string]string{"DATABASE_URL": "mysql://x"}, "postgres:// URL"},
		{"unknown env", map[string]string{"DATABASE_URL": "postgres://x/db", "APP_ENV": "staging"}, "APP_ENV"},
		{"unknown zone", map[string]string{"DATABASE_URL": "postgres://x/db", "APP_TIMEZONE": "Mars/Base"}, "APP_TIMEZONE"},
		{"local zone", map[string]string{"DATABASE_URL": "postgres://x/db", "APP_TIMEZONE": "Local"}, "APP_TIMEZONE"},
		{"bad log level", map[string]string{"DATABASE_URL": "postgres://x/db", "LOG_LEVEL": "loud"}, "LOG_LEVEL"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Load(envFrom(tt.env))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Load error = %v, want mention of %q", err, tt.want)
			}
		})
	}
}
