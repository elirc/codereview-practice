package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/apperr"
	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/geo"
	"deliverydispatch/services/orders/internal/domain"
	"deliverydispatch/services/orders/internal/store/db"
)

// ListRestaurants returns the active restaurants.
func (s *Service) ListRestaurants(ctx context.Context) ([]db.Restaurant, error) {
	if _, err := auth.Require(ctx, auth.RoleCustomer, auth.RoleRestaurant, auth.RoleOps); err != nil {
		return nil, err
	}
	rs, err := s.q.ListActiveRestaurants(ctx)
	if err != nil {
		return nil, fmt.Errorf("list restaurants: %w", err)
	}
	return rs, nil
}

// QuoteRequest is a validated request for a delivery quote.
type QuoteRequest struct {
	RestaurantID uuid.UUID
	Items        []domain.Item
	DropoffLon   float64
	DropoffLat   float64
}

// CreateQuote prices a delivery from a restaurant to a drop-off point for the
// calling customer and stores the quote.
func (s *Service) CreateQuote(ctx context.Context, req QuoteRequest) (db.Quote, error) {
	p, err := auth.Require(ctx, auth.RoleCustomer)
	if err != nil {
		return db.Quote{}, err
	}
	r, err := s.q.GetRestaurant(ctx, req.RestaurantID)
	if err != nil {
		return db.Quote{}, notFoundIfNoRows(err)
	}
	if !r.Active {
		return db.Quote{}, apperr.Unprocessable("restaurant_inactive", "The restaurant is not taking orders.")
	}
	distance := geo.CeilM(r.Lon, r.Lat, req.DropoffLon, req.DropoffLat)
	if distance > s.cfg.MaxDistanceM {
		return db.Quote{}, apperr.Unprocessable("out_of_range", "The drop-off point is too far from the restaurant.").
			WithDetails(map[string]any{"distance_m": distance, "max_distance_m": s.cfg.MaxDistanceM})
	}
	surge, err := s.surgeBps(ctx, r.ZoneID)
	if err != nil {
		return db.Quote{}, err
	}
	items, err := json.Marshal(req.Items)
	if err != nil {
		return db.Quote{}, fmt.Errorf("encode items: %w", err)
	}
	subtotal := domain.Subtotal(req.Items)
	fee := domain.DeliveryFee(s.cfg.Fees, distance, surge)
	now := s.clock.Now()
	q, err := s.q.InsertQuote(ctx, db.InsertQuoteParams{
		ID:               s.ids.NewID(),
		CustomerID:       p.Subject,
		RestaurantID:     r.ID,
		Items:            items,
		SubtotalMinor:    subtotal,
		DistanceM:        int32(distance),
		DeliveryFeeMinor: fee,
		SurgeBps:         int32(surge),
		TotalMinor:       subtotal + fee,
		EtaMinutes:       int32(domain.QuoteETAMinutes(int64(r.PrepMinutes), distance)),
		DropoffLon:       req.DropoffLon,
		DropoffLat:       req.DropoffLat,
		CreatedAt:        now,
		ExpiresAt:        now.Add(s.cfg.QuoteTTL),
	})
	if err != nil {
		return db.Quote{}, fmt.Errorf("insert quote: %w", err)
	}
	return q, nil
}

// surgeBps returns the zone's current multiplier from the surge projection.
func (s *Service) surgeBps(ctx context.Context, zoneID string) (int64, error) {
	z, err := s.q.GetZoneSurge(ctx, zoneID)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.NeutralSurgeBps, nil
	}
	if err != nil {
		return 0, fmt.Errorf("load zone surge: %w", err)
	}
	return int64(z.MultiplierBps), nil
}
