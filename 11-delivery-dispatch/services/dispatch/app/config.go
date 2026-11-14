package app

import (
	"time"

	"deliverydispatch/pkg/config"
	"deliverydispatch/services/dispatch/internal/service"
)

// Config is the dispatch service's configuration.
type Config struct {
	Common      config.Common
	HTTPAddr    string
	DatabaseURL string
	Service     service.Config
}

// LoadConfig reads and validates the dispatch configuration from lookup.
func LoadConfig(lookup config.LookupFunc) (Config, error) {
	l := config.New(lookup)
	common := config.LoadCommon(l)
	c := Config{
		Common:      common,
		HTTPAddr:    l.String("DISPATCH_HTTP_ADDR", ":8112"),
		DatabaseURL: l.Required("DISPATCH_DATABASE_URL"),
		Service: service.Config{
			Currency:                common.Currency,
			SearchTimeout:           l.Duration("SEARCH_TIMEOUT", 10*time.Minute),
			MaxOffers:               int32(l.Int64("MAX_OFFERS", 5, 1, 50)),
			OfferTTL:                l.Duration("OFFER_TTL", 30*time.Second),
			OfferRetry:              l.Duration("OFFER_RETRY", 5*time.Second),
			OfferRadiusM:            float64(l.Int64("OFFER_RADIUS_M", 5000, 1, 100_000)),
			PositionMaxAge:          l.Duration("POSITION_MAX_AGE", 120*time.Second),
			ReserveTimeout:          l.Duration("RESERVE_TIMEOUT", 20*time.Second),
			CourierBaseMinor:        l.Int64("COURIER_BASE_MINOR", 300, 0, 1_000_000),
			CourierShareBps:         l.Int64("COURIER_SHARE_BPS", 8000, 0, 10000),
			CancelCompensationMinor: l.Int64("CANCEL_COMPENSATION_MINOR", 400, 0, 1_000_000),
		},
	}
	if err := l.Err(); err != nil {
		return Config{}, err
	}
	return c, nil
}
