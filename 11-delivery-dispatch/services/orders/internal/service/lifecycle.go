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

// ConfirmSweepBatch is how many overdue orders one sweeper pass handles.
const ConfirmSweepBatch = 100

// Confirm accepts a placed order for the caller's restaurant (or any order for
// ops), sets its ready time and returns it.
func (s *Service) Confirm(ctx context.Context, id uuid.UUID) (db.Order, error) {
	p, err := auth.Require(ctx, auth.RoleRestaurant, auth.RoleOps)
	if err != nil {
		return db.Order{}, err
	}
	var out db.Order
	err = pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		o, err := s.lockVisible(ctx, q, p, id)
		if err != nil {
			return err
		}
		now := s.clock.Now()
		if o.Status != domain.StatusPlaced {
			if o.Status == domain.StatusCancelled && deref(o.CancelReason) == domain.ReasonConfirmTimeout {
				return confirmWindowClosed()
			}
			return apperr.InvalidState("Only placed orders can be confirmed.")
		}
		if !now.Before(o.ConfirmDeadline) {
			return confirmWindowClosed()
		}
		restaurant, err := q.GetRestaurant(ctx, o.RestaurantID)
		if err != nil {
			return fmt.Errorf("load restaurant: %w", err)
		}
		after := o
		after.Status = domain.StatusConfirmed
		readyAt := now.Add(time.Duration(restaurant.PrepMinutes) * time.Minute)
		after.ReadyAt = &readyAt
		saved, err := s.save(ctx, q, o, after, "confirmed", now)
		if err != nil {
			return err
		}
		if err := s.emitConfirmed(ctx, tx, saved, now); err != nil {
			return err
		}
		out = saved
		return nil
	})
	return out, err
}

func confirmWindowClosed() error {
	return apperr.Conflict("confirm_window_closed", "The confirmation window for this order has closed.")
}

// Reject declines a placed order for the caller's restaurant (or any order
// for ops), cancelling it with a full refund.
func (s *Service) Reject(ctx context.Context, id uuid.UUID) (db.Order, error) {
	p, err := auth.Require(ctx, auth.RoleRestaurant, auth.RoleOps)
	if err != nil {
		return db.Order{}, err
	}
	var out db.Order
	err = pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		o, err := s.lockVisible(ctx, q, p, id)
		if err != nil {
			return err
		}
		if o.Status != domain.StatusPlaced {
			return apperr.InvalidState("Only placed orders can be rejected.")
		}
		now := s.clock.Now()
		saved, err := s.save(ctx, q, o, cancelled(o, domain.ReasonRestaurantRejected, 0), "rejected", now)
		if err != nil {
			return err
		}
		if err := s.emitCancelled(ctx, tx, saved, now); err != nil {
			return err
		}
		out = saved
		return nil
	})
	return out, err
}

// SweepConfirmDeadlines cancels placed orders whose confirmation deadline is
// at or before now. Each order is handled in its own transaction; it returns
// how many were cancelled.
func (s *Service) SweepConfirmDeadlines(ctx context.Context, now time.Time) (int, error) {
	ids, err := s.q.ListExpiredPlacedOrders(ctx, db.ListExpiredPlacedOrdersParams{Now: now, BatchSize: ConfirmSweepBatch})
	if err != nil {
		return 0, fmt.Errorf("list overdue orders: %w", err)
	}
	done := 0
	for _, id := range ids {
		ok, err := s.expireOrder(ctx, id, now)
		if err != nil {
			s.logger.ErrorContext(ctx, "confirm timeout failed", "order_id", id, "error", err.Error())
			continue
		}
		if ok {
			done++
		}
	}
	return done, nil
}

func (s *Service) expireOrder(ctx context.Context, id uuid.UUID, now time.Time) (bool, error) {
	var expired bool
	err := pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		o, err := q.GetOrderForUpdate(ctx, id)
		if err != nil {
			return err
		}
		if o.Status != domain.StatusPlaced || now.Before(o.ConfirmDeadline) {
			return nil
		}
		saved, err := s.save(ctx, q, o, cancelled(o, domain.ReasonConfirmTimeout, 0), "confirm_timeout", now)
		if err != nil {
			return err
		}
		if err := s.emitCancelled(ctx, tx, saved, now); err != nil {
			return err
		}
		expired = true
		return nil
	})
	return expired, err
}
