package app

import (
	"deliverydispatch/pkg/config"
)

// Config is the couriers service's configuration.
type Config struct {
	Common      config.Common
	HTTPAddr    string
	DatabaseURL string
}

// LoadConfig reads and validates the couriers configuration from lookup.
func LoadConfig(lookup config.LookupFunc) (Config, error) {
	l := config.New(lookup)
	c := Config{
		Common:      config.LoadCommon(l),
		HTTPAddr:    l.String("COURIERS_HTTP_ADDR", ":8113"),
		DatabaseURL: l.Required("COURIERS_DATABASE_URL"),
	}
	if err := l.Err(); err != nil {
		return Config{}, err
	}
	return c, nil
}
