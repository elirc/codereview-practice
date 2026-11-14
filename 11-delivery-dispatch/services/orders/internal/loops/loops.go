// Package loops defines the orders service's periodic jobs.
package loops

import (
	"context"
	"time"

	"deliverydispatch/pkg/runner"
	"deliverydispatch/services/orders/internal/service"
)

// ConfirmSweeper cancels placed orders whose confirmation deadline has passed.
func ConfirmSweeper(svc *service.Service) runner.Loop {
	return runner.Loop{
		Name:     "confirm-sweeper",
		Interval: 5 * time.Second,
		RunOnce: func(ctx context.Context, now time.Time) error {
			_, err := svc.SweepConfirmDeadlines(ctx, now)
			return err
		},
	}
}
