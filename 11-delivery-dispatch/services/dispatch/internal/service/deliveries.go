package service

import (
	"context"

	"github.com/google/uuid"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/auth"
	"deliverydispatch/services/dispatch/internal/store/db"
)

// GetDelivery returns a delivery to its courier or to ops.
func (s *Service) GetDelivery(ctx context.Context, id uuid.UUID) (db.Delivery, error) {
	p, err := auth.Require(ctx, auth.RoleCourier, auth.RoleOps)
	if err != nil {
		return db.Delivery{}, err
	}
	d, err := s.q.GetDelivery(ctx, id)
	if err != nil {
		return db.Delivery{}, notFoundIfNoRows(err)
	}
	if p.Role == auth.RoleCourier && !isCourierOf(d, p.Subject) {
		return db.Delivery{}, apperr.NotFound()
	}
	return d, nil
}

func isCourierOf(d db.Delivery, courierID uuid.UUID) bool {
	return d.CourierID.Valid && d.CourierID.UUID == courierID
}
