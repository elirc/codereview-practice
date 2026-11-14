package app

import (
	"time"

	"deliverydispatch/pkg/config"
	"deliverydispatch/services/orders/internal/domain"
	"deliverydispatch/services/orders/internal/service"
)

// Config is the orders service's configuration.
type Config struct {
	Common      config.Common
	HTTPAddr    string
	DatabaseURL string
	Service     service.Config
}

// LoadConfig reads and validates the orders configuration from lookup.
func LoadConfig(lookup config.LookupFunc) (Config, error) {
	l := config.New(lookup)
	common := config.LoadCommon(l)
	c := Config{
		Common:      common,
		HTTPAddr:    l.String("ORDERS_HTTP_ADDR", ":8111"),
		DatabaseURL: l.Required("ORDERS_DATABASE_URL"),
		Service: service.Config{
			Currency: common.Currency,
			Fees: domain.FeeRules{
				BaseFeeMinor: l.Int64("BASE_FEE_MINOR", 199, 0, 1_000_000),
				PerKmMinor:   l.Int64("PER_KM_MINOR", 60, 0, 1_000_000),
			},
			MaxDistanceM:    l.Int64("MAX_DISTANCE_M", 15000, 1, 100_000),
			QuoteTTL:        l.Duration("QUOTE_TTL", 5*time.Minute),
			ConfirmTimeout:  l.Duration("CONFIRM_TIMEOUT", 5*time.Minute),
			MaxActiveOrders: l.Int64("MAX_ACTIVE_ORDERS", 3, 1, 100),
			CancelFeeMinor:  l.Int64("CANCEL_FEE_MINOR", 500, 0, 1_000_000),
			CancelRetry:     l.Duration("CANCEL_REQUEST_RETRY", 2*time.Minute),
		},
	}
	if err := l.Err(); err != nil {
		return Config{}, err
	}
	return c, nil
}
