// Package config loads and validates process configuration from the
// environment. It is read once at start-up.
package config

import (
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"
)

// Application environments accepted in APP_ENV.
const (
	EnvDevelopment = "development"
	EnvTest        = "test"
	EnvProduction  = "production"
)

// Config holds every setting the process needs.
type Config struct {
	DatabaseURL string
	HTTPAddr    string
	Env         string
	Location    *time.Location
	LogLevel    slog.Level
}

// Production reports whether the process runs in the production environment.
func (c Config) Production() bool {
	return c.Env == EnvProduction
}

// Load reads configuration through getenv. All problems are reported together
// so a misconfigured deployment can be fixed in one pass.
func Load(getenv func(string) string) (Config, error) {
	var problems []string

	cfg := Config{
		DatabaseURL: strings.TrimSpace(getenv("DATABASE_URL")),
		HTTPAddr:    valueOr(getenv("HTTP_ADDR"), ":8087"),
		Env:         valueOr(getenv("APP_ENV"), EnvDevelopment),
	}

	if cfg.DatabaseURL == "" {
		problems = append(problems, "DATABASE_URL is required")
	} else if u, err := url.Parse(cfg.DatabaseURL); err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		problems = append(problems, "DATABASE_URL must be a postgres:// URL")
	}

	switch cfg.Env {
	case EnvDevelopment, EnvTest, EnvProduction:
	default:
		problems = append(problems, fmt.Sprintf("APP_ENV must be one of %s, %s, %s", EnvDevelopment, EnvTest, EnvProduction))
	}

	zone := valueOr(getenv("APP_TIMEZONE"), "America/Chicago")
	if zone == "Local" {
		problems = append(problems, "APP_TIMEZONE must be an IANA zone name")
	} else if loc, err := time.LoadLocation(zone); err != nil {
		problems = append(problems, fmt.Sprintf("APP_TIMEZONE %q is not a known IANA zone", zone))
	} else {
		cfg.Location = loc
	}

	if err := cfg.LogLevel.UnmarshalText([]byte(valueOr(getenv("LOG_LEVEL"), "info"))); err != nil {
		problems = append(problems, "LOG_LEVEL must be debug, info, warn or error")
	}

	if len(problems) > 0 {
		return Config{}, fmt.Errorf("invalid configuration: %s", strings.Join(problems, "; "))
	}
	return cfg, nil
}

func valueOr(v, fallback string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return fallback
	}
	return v
}
