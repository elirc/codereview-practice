package service

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/pgxtx"
	"deliverydispatch/services/orders/internal/domain"
	"deliverydispatch/services/orders/internal/store/db"
)

// CancelRetryBatch is how many due cancel requests one retry pass handles.
const CancelRetryBatch = 100

// CancelResult is the outcome of a cancellation request. Pending is true when
// dispatch has been asked and its answer is awaited.
type CancelResult struct {
	Order   db.Order
	Pending bool
}

func requesterFor(role auth.Role) string {
	switch role {
	case auth.RoleCustomer:
		return domain.RequesterCustomer
	case auth.RoleRestaurant:
		return domain.RequesterRestaurant
	default:
		return domain.RequesterOps
	}
}

// Cancel asks for an order to be cancelled. A placed order is cancelled at
// once with a full refund; a confirmed or assigned order sends a cancel
// request to dispatch; any later status is refused.
func (s *Service) Cancel(ctx context.Context, id uuid.UUID, note *string) (CancelResult, error) {
	p, err := auth.Require(ctx, auth.RoleCustomer, auth.RoleRestaurant, auth.RoleOps)
	if err != nil {
		return CancelResult{}, err
	}
	var out CancelResult
	err = pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		o, err := s.lockVisible(ctx, q, p, id)
		if err != nil {
			return err
		}
		now := s.clock.Now()
		by := requesterFor(p.Role)
		switch domain.DecideCancel(o.Status, o.CancelRequest) {
		case domain.CancelNow:
			after := cancelled(o, by, 0)
			after.CancelRequestedBy = &by
			after.CancelRequestedAt = &now
			after.CancelNote = note
			saved, err := s.save(ctx, q, o, after, "cancelled_by_"+by, now)
			if err != nil {
				return err
			}
			out = CancelResult{Order: saved}
			return s.emitCancelled(ctx, tx, saved, now)
		case domain.CancelAlreadyPending:
			out = CancelResult{Order: o, Pending: true}
			return nil
		case domain.CancelAskDispatch:
			retryAt := now.Add(s.cfg.CancelRetry)
			after := o
			after.CancelRequest = domain.CancelRequestPending
			after.CancelRequestedBy = &by
			after.CancelRequestedAt = &now
			after.CancelRequestAttempts = 1
			after.CancelRetryAt = &retryAt
			after.CancelNote = note
			saved, err := s.save(ctx, q, o, after, "cancel_requested", now)
			if err != nil {
				return err
			}
			out = CancelResult{Order: saved, Pending: true}
			return s.emitCancelRequested(ctx, tx, saved, now)
		default:
			return apperr.Conflict("not_cancellable", "The order can no longer be cancelled.")
		}
	})
	return out, err
}

// RetryCancelRequests sends unanswered cancel requests again, at most
// MaxCancelRetries times per request, and returns how many it sent.
func (s *Service) RetryCancelRequests(ctx context.Context, now time.Time) (int, error) {
	ids, err := s.q.ListDueCancelRetries(ctx, db.ListDueCancelRetriesParams{Now: now, BatchSize: CancelRetryBatch})
	if err != nil {
		return 0, fmt.Errorf("list due cancel requests: %w", err)
	}
	sent := 0
	for _, id := range ids {
		ok, err := s.retryCancel(ctx, id, now)
		if err != nil {
			s.logger.ErrorContext(ctx, "cancel request retry failed", "order_id", id, "error", err.Error())
			continue
		}
		if ok {
			sent++
		}
	}
	return sent, nil
}

func (s *Service) retryCancel(ctx context.Context, id uuid.UUID, now time.Time) (bool, error) {
	var sent bool
	err := pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		o, err := q.GetOrderForUpdate(ctx, id)
		if err != nil {
			return err
		}
		if o.CancelRequest != domain.CancelRequestPending || domain.IsTerminal(o.Status) ||
			o.CancelRetryAt == nil || now.Before(*o.CancelRetryAt) {
			return nil
		}
		after := o
		if o.CancelRequestAttempts > MaxCancelRetries {
			s.logger.WarnContext(ctx, "cancel request unanswered; left pending for ops",
				"order_id", o.ID, "attempts", o.CancelRequestAttempts)
			after.CancelRetryAt = nil
			_, err := s.save(ctx, q, o, after, "cancel_request_unanswered", now)
			return err
		}
		retryAt := now.Add(s.cfg.CancelRetry)
		after.CancelRequestAttempts++
		after.CancelRetryAt = &retryAt
		saved, err := s.save(ctx, q, o, after, "cancel_request_retried", now)
		if err != nil {
			return err
		}
		sent = true
		return s.emitCancelRequested(ctx, tx, saved, now)
	})
	return sent, err
}
