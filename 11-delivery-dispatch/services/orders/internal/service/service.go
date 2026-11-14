// Package service implements the orders service's use cases, each in its own
// transaction.
package service

import (
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/clock"
	"deliverydispatch/pkg/idgen"
	"deliverydispatch/pkg/natsx"
	"deliverydispatch/pkg/outbox"
	"deliverydispatch/services/orders/internal/domain"
	"deliverydispatch/services/orders/internal/store/db"
)

// Config holds the business settings of the orders service.
type Config struct {
	Currency        string
	Fees            domain.FeeRules
	MaxDistanceM    int64
	QuoteTTL        time.Duration
	ConfirmTimeout  time.Duration
	MaxActiveOrders int64
	CancelFeeMinor  int64
	CancelRetry     time.Duration
}

// MaxCancelRetries is how many times an unanswered cancel request is sent again.
const MaxCancelRetries = 5

// Service is the orders service.
type Service struct {
	pool   *pgxpool.Pool
	q      *db.Queries
	cfg    Config
	clock  clock.Clock
	ids    idgen.Generator
	emit   *outbox.Emitter
	logger *slog.Logger
}

// New returns a Service backed by pool.
func New(pool *pgxpool.Pool, cfg Config, clk clock.Clock, ids idgen.Generator, logger *slog.Logger) *Service {
	return &Service{
		pool:   pool,
		q:      db.New(pool),
		cfg:    cfg,
		clock:  clk,
		ids:    ids,
		emit:   outbox.NewEmitter(natsx.StreamOrders.Prefix, ids),
		logger: logger,
	}
}

func notFoundIfNoRows(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound()
	}
	return err
}
