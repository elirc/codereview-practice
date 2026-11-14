package service

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/auth"
	"deliverydispatch/services/couriers/internal/domain"
	"deliverydispatch/services/couriers/internal/store/db"
)

// recordEarning stores an earning once per courier, delivery and kind.
func (s *Service) recordEarning(ctx context.Context, q *db.Queries, courierID, deliveryID uuid.UUID, kind string, amountMinor int64) error {
	if _, err := q.InsertEarning(ctx, db.InsertEarningParams{
		ID:          s.ids.NewID(),
		CourierID:   courierID,
		DeliveryID:  deliveryID,
		Kind:        kind,
		AmountMinor: amountMinor,
		CreatedAt:   s.clock.Now(),
	}); err != nil {
		return fmt.Errorf("insert earning: %w", err)
	}
	return nil
}

// HandleDelivered detaches the courier from the delivery and records their
// delivery earning.
func (s *Service) HandleDelivered(ctx context.Context, tx pgx.Tx, deliveryID, courierID uuid.UUID, payoutMinor int64) error {
	if err := s.ReleaseCourier(ctx, tx, deliveryID, courierID); err != nil {
		return err
	}
	return s.recordEarning(ctx, s.q.WithTx(tx), courierID, deliveryID, domain.EarningDelivery, payoutMinor)
}

// Earnings is a courier's earning history and total.
type Earnings struct {
	CourierID  uuid.UUID
	TotalMinor int64
	Items      []db.CourierEarning
}

// MyEarnings returns the calling courier's earnings.
func (s *Service) MyEarnings(ctx context.Context) (Earnings, error) {
	p, err := auth.Require(ctx, auth.RoleCourier)
	if err != nil {
		return Earnings{}, err
	}
	return s.earnings(ctx, p.Subject)
}

// CourierEarnings returns any courier's earnings (ops only).
func (s *Service) CourierEarnings(ctx context.Context, id uuid.UUID) (Earnings, error) {
	if _, err := auth.Require(ctx, auth.RoleOps); err != nil {
		return Earnings{}, err
	}
	if _, err := s.q.GetCourier(ctx, id); err != nil {
		return Earnings{}, notFoundIfNoRows(err)
	}
	return s.earnings(ctx, id)
}

func (s *Service) earnings(ctx context.Context, id uuid.UUID) (Earnings, error) {
	items, err := s.q.ListEarnings(ctx, id)
	if err != nil {
		return Earnings{}, fmt.Errorf("list earnings: %w", err)
	}
	total, err := s.q.SumEarnings(ctx, id)
	if err != nil {
		return Earnings{}, fmt.Errorf("sum earnings: %w", err)
	}
	return Earnings{CourierID: id, TotalMinor: total, Items: items}, nil
}
