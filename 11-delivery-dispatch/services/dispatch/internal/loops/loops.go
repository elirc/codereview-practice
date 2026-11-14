// Package loops defines the dispatch service's periodic jobs.
package loops

import (
	"context"
	"time"

	"deliverydispatch/pkg/runner"
	"deliverydispatch/services/dispatch/internal/service"
)

func loop(name string, interval time.Duration, fn func(context.Context, time.Time) (int, error)) runner.Loop {
	return runner.Loop{
		Name:     name,
		Interval: interval,
		RunOnce: func(ctx context.Context, now time.Time) error {
			_, err := fn(ctx, now)
			return err
		},
	}
}

// Offers makes offers for due searching deliveries.
func Offers(svc *service.Service) runner.Loop {
	return loop("offer-loop", time.Second, svc.RunOffers)
}

// OfferExpiry closes expired pending offers.
func OfferExpiry(svc *service.Service) runner.Loop {
	return loop("offer-expiry", time.Second, svc.ExpireOffers)
}

// ReservationExpiry releases reservations past their deadline.
func ReservationExpiry(svc *service.Service) runner.Loop {
	return loop("reservation-expiry", 2*time.Second, svc.ExpireReservations)
}

// Surge recomputes zone surge multipliers.
func Surge(svc *service.Service) runner.Loop {
	return loop("surge", 30*time.Second, svc.RunSurge)
}
