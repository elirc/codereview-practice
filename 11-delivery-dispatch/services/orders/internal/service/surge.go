package service

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"deliverydispatch/services/orders/internal/store/db"
)

// ApplySurge stores a zone's surge multiplier when sequence is newer than the
// stored version.
func (s *Service) ApplySurge(ctx context.Context, tx pgx.Tx, zoneID string, multiplierBps int32, sequence int64) error {
	_, err := s.q.WithTx(tx).ApplyZoneSurge(ctx, db.ApplyZoneSurgeParams{
		ZoneID:        zoneID,
		MultiplierBps: multiplierBps,
		Version:       sequence,
		UpdatedAt:     s.clock.Now(),
	})
	if err != nil {
		return fmt.Errorf("apply zone surge: %w", err)
	}
	return nil
}
