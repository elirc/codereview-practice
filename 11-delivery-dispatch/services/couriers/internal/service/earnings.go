package service

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/apperr"
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

// Earnings is a courier's earning history, total and total per kind.
type Earnings struct {
	CourierID  uuid.UUID
	TotalMinor int64
	ByKind     map[string]int64
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

// MyDeliveryEarnings returns what the calling courier earned for one
// delivery. A delivery with no earnings is not found.
func (s *Service) MyDeliveryEarnings(ctx context.Context, deliveryID uuid.UUID) (Earnings, error) {
	p, err := auth.Require(ctx, auth.RoleCourier)
	if err != nil {
		return Earnings{}, err
	}
	items, err := s.q.ListDeliveryEarnings(ctx, deliveryID)
	if err != nil {
		return Earnings{}, fmt.Errorf("list delivery earnings: %w", err)
	}
	if len(items) == 0 {
		return Earnings{}, apperr.NotFound()
	}
	out := Earnings{CourierID: p.Subject, ByKind: map[string]int64{}, Items: items}
	for _, it := range items {
		out.TotalMinor += it.AmountMinor
		out.ByKind[it.Kind] += it.AmountMinor
	}
	return out, nil
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
	kinds, err := s.q.SumEarningsByKind(ctx, id)
	if err != nil {
		return Earnings{}, fmt.Errorf("sum earnings by kind: %w", err)
	}
	byKind := make(map[string]int64, len(kinds))
	for _, k := range kinds {
		byKind[k.Kind] = k.TotalMinor
	}
	return Earnings{CourierID: id, TotalMinor: total, ByKind: byKind, Items: items}, nil
}

// HandleCancelled detaches the named courier from a cancelled delivery and,
// when the courier had been assigned, records their compensation.
func (s *Service) HandleCancelled(ctx context.Context, tx pgx.Tx, deliveryID uuid.UUID, courierID uuid.NullUUID, courierWasAssigned bool, compensationMinor int64) error {
	if !courierID.Valid {
		return nil
	}
	if err := s.ReleaseCourier(ctx, tx, deliveryID, courierID.UUID); err != nil {
		return err
	}
	if !courierWasAssigned {
		return nil
	}
	return s.recordEarning(ctx, s.q.WithTx(tx), courierID.UUID, deliveryID, domain.EarningCompensation, compensationMinor)
}
