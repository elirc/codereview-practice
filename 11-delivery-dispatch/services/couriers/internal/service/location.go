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
	"deliverydispatch/services/couriers/internal/domain"
	"deliverydispatch/services/couriers/internal/store/db"
)

// Ping is a validated location report.
type Ping struct {
	Lon        float64
	Lat        float64
	RecordedAt time.Time
}

type locationUpdatedData struct {
	CourierID  uuid.UUID `json:"courier_id"`
	Lon        float64   `json:"lon"`
	Lat        float64   `json:"lat"`
	RecordedAt time.Time `json:"recorded_at"`
}

// ReportLocation records the calling courier's position. Pings that are too
// old are accepted and dropped; newer pings replace the stored position and
// are published as courier.location_updated when the publish rules allow.
func (s *Service) ReportLocation(ctx context.Context, ping Ping) error {
	p, err := auth.Require(ctx, auth.RoleCourier)
	if err != nil {
		return err
	}
	now := s.clock.Now()
	switch domain.JudgeLocation(ping.RecordedAt, now) {
	case domain.LocationInFuture:
		return apperr.Unprocessable("timestamp_in_future", "recorded_at is too far in the future.")
	case domain.LocationTooOld:
		return nil
	}
	return pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		c, err := q.GetCourierForUpdate(ctx, p.Subject)
		if err != nil {
			return notFoundIfNoRows(err)
		}
		if !domain.ShouldReplacePosition(c.PositionAt, ping.RecordedAt) {
			return nil
		}
		if err := q.UpdateCourierPosition(ctx, db.UpdateCourierPositionParams{
			Lon:        ping.Lon,
			Lat:        ping.Lat,
			PositionAt: ping.RecordedAt,
			UpdatedAt:  now,
			ID:         c.ID,
		}); err != nil {
			return fmt.Errorf("store position: %w", err)
		}
		distance, err := q.DistanceFromPublished(ctx, db.DistanceFromPublishedParams{Lon: ping.Lon, Lat: ping.Lat, ID: c.ID})
		if err != nil {
			return fmt.Errorf("measure distance: %w", err)
		}
		if !domain.ShouldPublishLocation(c.ShiftZoneID != nil, c.PublishedAt, ping.RecordedAt, distance) {
			return nil
		}
		seq := c.PositionSeq + 1
		if err := q.MarkPositionPublished(ctx, db.MarkPositionPublishedParams{
			Lon:         ping.Lon,
			Lat:         ping.Lat,
			PublishedAt: ping.RecordedAt,
			PositionSeq: seq,
			ID:          c.ID,
		}); err != nil {
			return fmt.Errorf("mark published: %w", err)
		}
		return s.emitCourierEvent(ctx, tx, c.ID, EventLocationUpdated, seq, now, locationUpdatedData{
			CourierID:  c.ID,
			Lon:        ping.Lon,
			Lat:        ping.Lat,
			RecordedAt: ping.RecordedAt.UTC(),
		})
	})
}
