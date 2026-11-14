package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/outbox"
	"deliverydispatch/pkg/pgxtx"
	"deliverydispatch/services/dispatch/internal/domain"
	"deliverydispatch/services/dispatch/internal/store/db"
)

// RunSurge recomputes every active zone's surge, one transaction per zone,
// and returns how many zones changed.
func (s *Service) RunSurge(ctx context.Context, now time.Time) (int, error) {
	zones, err := s.q.ListSurgeZones(ctx)
	if err != nil {
		return 0, fmt.Errorf("list zones: %w", err)
	}
	changed := 0
	for _, zone := range zones {
		ok, err := s.updateZoneSurge(ctx, zone, now)
		if err != nil {
			s.logger.ErrorContext(ctx, "surge update failed", "zone_id", zone, "error", err.Error())
			continue
		}
		if ok {
			changed++
		}
	}
	return changed, nil
}

func (s *Service) updateZoneSurge(ctx context.Context, zone string, now time.Time) (bool, error) {
	var changed bool
	err := pgxtx.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if err := q.EnsureZoneSurge(ctx, db.EnsureZoneSurgeParams{ZoneID: zone, ComputedAt: now}); err != nil {
			return fmt.Errorf("ensure zone surge: %w", err)
		}
		z, err := q.GetZoneSurgeForUpdate(ctx, zone)
		if err != nil {
			return fmt.Errorf("lock zone surge: %w", err)
		}
		demand, err := q.CountZoneDemand(ctx, zone)
		if err != nil {
			return fmt.Errorf("count demand: %w", err)
		}
		supply, err := q.CountZoneSupply(ctx, db.CountZoneSupplyParams{ZoneID: zone, FreshAfter: now.Add(-s.cfg.PositionMaxAge)})
		if err != nil {
			return fmt.Errorf("count supply: %w", err)
		}
		bps := domain.SurgeBps(demand, supply)
		if bps == z.MultiplierBps {
			return nil
		}
		version := z.Version + 1
		if err := q.UpdateZoneSurge(ctx, db.UpdateZoneSurgeParams{MultiplierBps: bps, Version: version, ComputedAt: now, ZoneID: zone}); err != nil {
			return fmt.Errorf("update zone surge: %w", err)
		}
		changed = true
		_, err = s.emit.Emit(ctx, tx, outbox.Event{
			Type:          EventSurgeUpdated,
			AggregateType: aggregateZone,
			AggregateID:   zone,
			Sequence:      version,
			OccurredAt:    now,
			Data:          surgeUpdatedData{ZoneID: zone, MultiplierBps: bps},
		})
		return err
	})
	return changed, err
}

// ZoneSurge returns a zone's stored surge (ops only); a zone never computed
// reports the neutral multiplier at version 0.
func (s *Service) ZoneSurge(ctx context.Context, zone string) (db.ZoneSurge, error) {
	if _, err := auth.Require(ctx, auth.RoleOps); err != nil {
		return db.ZoneSurge{}, err
	}
	z, err := s.q.GetZoneSurge(ctx, zone)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.ZoneSurge{ZoneID: zone, MultiplierBps: domain.NeutralSurgeBps, ComputedAt: s.clock.Now()}, nil
	}
	if err != nil {
		return db.ZoneSurge{}, fmt.Errorf("load zone surge: %w", err)
	}
	return z, nil
}
