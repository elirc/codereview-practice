// Package seed loads the couriers service's demo data.
package seed

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"deliverydispatch/pkg/auth"
	"deliverydispatch/services/couriers/internal/store/db"
)

var couriers = []struct {
	name    string
	vehicle string
}{
	{"Tunde Bike", "bike"},
	{"Amaka Scooter", "scooter"},
	{"Chidi Car", "car"},
}

// Run upserts the seed couriers and prints a token for each and for ops.
func Run(ctx context.Context, pool *pgxpool.Pool, secret []byte, now time.Time, out io.Writer) error {
	q := db.New(pool)
	tokens := map[string]auth.Principal{"ops": auth.SeedOps}
	for i, c := range couriers {
		id := auth.SeedCourierIDs[i]
		if err := q.UpsertCourier(ctx, db.UpsertCourierParams{ID: id, Name: c.name, Vehicle: c.vehicle, CreatedAt: now}); err != nil {
			return fmt.Errorf("seed courier %s: %w", c.name, err)
		}
		tokens[fmt.Sprintf("courier-%d", i+1)] = auth.Principal{Subject: id, Role: auth.RoleCourier}
	}
	fmt.Fprintf(out, "seeded %d couriers\n", len(couriers))
	return auth.PrintSeedTokens(out, secret, now, tokens)
}
