package service

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/pgxtx"
	"deliverydispatch/services/couriers/internal/store/db"
)

// CreateCourier registers a courier (ops only) and records their initial
// offline status.
func (s *Service) CreateCourier(ctx context.Context, name, vehicle string) (db.Courier, error) {
	if _, err := auth.Require(ctx, auth.RoleOps); err != nil {
		return db.Courier{}, err
	}
	var out db.Courier
	err := pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		now := s.clock.Now()
		c, err := q.InsertCourier(ctx, db.InsertCourierParams{ID: s.ids.NewID(), Name: name, Vehicle: vehicle, CreatedAt: now})
		if err != nil {
			return fmt.Errorf("insert courier: %w", err)
		}
		if err := s.emitCourierEvent(ctx, tx, c.ID, EventStatusChanged, c.StatusVersion, now, statusChangedData{
			CourierID: c.ID,
			Status:    Status(c),
			Vehicle:   c.Vehicle,
		}); err != nil {
			return err
		}
		out = c
		return nil
	})
	return out, err
}

// Me returns the calling courier.
func (s *Service) Me(ctx context.Context) (db.Courier, error) {
	p, err := auth.Require(ctx, auth.RoleCourier)
	if err != nil {
		return db.Courier{}, err
	}
	c, err := s.q.GetCourier(ctx, p.Subject)
	if err != nil {
		return db.Courier{}, notFoundIfNoRows(err)
	}
	return c, nil
}

// GetCourier returns any courier (ops only).
func (s *Service) GetCourier(ctx context.Context, id uuid.UUID) (db.Courier, error) {
	if _, err := auth.Require(ctx, auth.RoleOps); err != nil {
		return db.Courier{}, err
	}
	c, err := s.q.GetCourier(ctx, id)
	if err != nil {
		return db.Courier{}, notFoundIfNoRows(err)
	}
	return c, nil
}

// mutate locks courier id, applies change and stores the result through
// commitStatus.
func (s *Service) mutate(ctx context.Context, id uuid.UUID, change func(c db.Courier) (db.Courier, error)) (db.Courier, error) {
	var out db.Courier
	err := pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		c, err := q.GetCourierForUpdate(ctx, id)
		if err != nil {
			return notFoundIfNoRows(err)
		}
		after, err := change(c)
		if err != nil {
			return err
		}
		out, err = s.commitStatus(ctx, tx, q, c, after, s.clock.Now())
		return err
	})
	return out, err
}

// StartShift puts the calling courier on shift in zoneID.
func (s *Service) StartShift(ctx context.Context, zoneID string) (db.Courier, error) {
	p, err := auth.Require(ctx, auth.RoleCourier)
	if err != nil {
		return db.Courier{}, err
	}
	return s.mutate(ctx, p.Subject, func(c db.Courier) (db.Courier, error) {
		if c.Suspended {
			return c, apperr.New(apperr.KindForbidden, "courier_suspended", "Suspended couriers cannot start a shift.")
		}
		if c.ShiftZoneID != nil {
			if *c.ShiftZoneID == zoneID {
				return c, nil
			}
			return c, apperr.Conflict("shift_active", "End the current shift before starting one in another zone.")
		}
		z := zoneID
		c.ShiftZoneID = &z
		return c, nil
	})
}

// EndShift takes the calling courier off shift.
func (s *Service) EndShift(ctx context.Context) (db.Courier, error) {
	p, err := auth.Require(ctx, auth.RoleCourier)
	if err != nil {
		return db.Courier{}, err
	}
	return s.mutate(ctx, p.Subject, func(c db.Courier) (db.Courier, error) {
		if c.ActiveDeliveryID.Valid {
			return c, apperr.Conflict("active_delivery", "Finish the active delivery before ending the shift.")
		}
		c.ShiftZoneID = nil
		return c, nil
	})
}

// Suspend suspends a courier (ops only) and ends their shift. A delivery in
// progress is left to finish.
func (s *Service) Suspend(ctx context.Context, id uuid.UUID) (db.Courier, error) {
	if _, err := auth.Require(ctx, auth.RoleOps); err != nil {
		return db.Courier{}, err
	}
	return s.mutate(ctx, id, func(c db.Courier) (db.Courier, error) {
		c.Suspended = true
		c.ShiftZoneID = nil
		return c, nil
	})
}

// Reinstate lifts a suspension (ops only). The courier stays off shift.
func (s *Service) Reinstate(ctx context.Context, id uuid.UUID) (db.Courier, error) {
	if _, err := auth.Require(ctx, auth.RoleOps); err != nil {
		return db.Courier{}, err
	}
	return s.mutate(ctx, id, func(c db.Courier) (db.Courier, error) {
		c.Suspended = false
		return c, nil
	})
}

// SeedCourier creates or updates the courier with a fixed id, then records
// their current status under a new status_version.
func (s *Service) SeedCourier(ctx context.Context, id uuid.UUID, name, vehicle string) (db.Courier, error) {
	var out db.Courier
	err := pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		now := s.clock.Now()
		if err := q.UpsertCourier(ctx, db.UpsertCourierParams{ID: id, Name: name, Vehicle: vehicle, CreatedAt: now}); err != nil {
			return fmt.Errorf("upsert courier: %w", err)
		}
		c, err := q.GetCourierForUpdate(ctx, id)
		if err != nil {
			return fmt.Errorf("lock courier: %w", err)
		}
		c.StatusVersion++
		c.UpdatedAt = now
		if err := q.UpdateCourierStatus(ctx, db.UpdateCourierStatusParams{
			Suspended:        c.Suspended,
			ShiftZoneID:      c.ShiftZoneID,
			ActiveDeliveryID: c.ActiveDeliveryID,
			StatusVersion:    c.StatusVersion,
			UpdatedAt:        now,
			ID:               c.ID,
		}); err != nil {
			return fmt.Errorf("update courier status: %w", err)
		}
		if err := s.emitCourierEvent(ctx, tx, c.ID, EventStatusChanged, c.StatusVersion, now, statusChangedData{
			CourierID: c.ID,
			Status:    Status(c),
			ZoneID:    c.ShiftZoneID,
			Vehicle:   c.Vehicle,
			Suspended: c.Suspended,
		}); err != nil {
			return err
		}
		out = c
		return nil
	})
	return out, err
}
