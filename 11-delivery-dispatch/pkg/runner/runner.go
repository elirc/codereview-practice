// Package runner runs periodic loops against an injected clock.
package runner

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/httpx"
	"deliverydispatch/pkg/idgen"
)

// Loop is one named periodic job.
type Loop struct {
	Name     string
	Interval time.Duration
	RunOnce  func(ctx context.Context, now time.Time) error
}

// Start runs every loop in its own goroutine until ctx is done; wg is
// incremented for each. A pass that is running when ctx is cancelled completes.
func Start(ctx context.Context, wg *sync.WaitGroup, clk clock.Clock, ids idgen.Generator, logger *slog.Logger, loops ...Loop) {
	for _, l := range loops {
		wg.Add(1)
		go func(l Loop) {
			defer wg.Done()
			run(ctx, clk, ids, logger.With("loop", l.Name), l)
		}(l)
	}
}

func run(ctx context.Context, clk clock.Clock, ids idgen.Generator, logger *slog.Logger, l Loop) {
	ticker := time.NewTicker(l.Interval)
	defer ticker.Stop()
	failures := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		runID := ids.NewID().String()
		pctx := httpx.WithRequestID(context.WithoutCancel(ctx), runID)
		logger.Debug("loop pass started", "run_id", runID)
		if err := l.RunOnce(pctx, clk.Now()); err != nil {
			failures++
			logger.Error("loop pass failed", "run_id", runID, "attempt", failures, "error", err.Error())
			continue
		}
		failures = 0
		logger.Debug("loop pass finished", "run_id", runID)
	}
}
