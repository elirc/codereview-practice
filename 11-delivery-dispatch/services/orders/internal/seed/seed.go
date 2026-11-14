// Package seed loads the orders service's demo data.
package seed

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"deliverydispatch/pkg/auth"
	"deliverydispatch/services/orders/internal/store/db"
)

// Restaurants are the seeded restaurants; the first belongs to the seed restaurant user.
var Restaurants = []db.UpsertRestaurantParams{
	{ID: auth.SeedRestaurantID, Name: "Iya Basira Kitchen", ZoneID: "lagos-yaba", Lon: 3.3792, Lat: 6.5244, PrepMinutes: 15, Active: true},
	{ID: uuid.MustParse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), Name: "Suya Spot Ikeja", ZoneID: "lagos-ikeja", Lon: 3.3515, Lat: 6.6018, PrepMinutes: 10, Active: true},
	{ID: uuid.MustParse("dddddddd-dddd-4ddd-8ddd-dddddddddddd"), Name: "Closed For Renovation", ZoneID: "lagos-yaba", Lon: 3.3801, Lat: 6.5150, PrepMinutes: 20, Active: false},
}

// Run upserts the seed restaurants and prints tokens for the seed users.
func Run(ctx context.Context, pool *pgxpool.Pool, secret []byte, now time.Time, out io.Writer) error {
	q := db.New(pool)
	for _, r := range Restaurants {
		r.CreatedAt = now
		if err := q.UpsertRestaurant(ctx, r); err != nil {
			return fmt.Errorf("seed restaurant %s: %w", r.Name, err)
		}
	}
	fmt.Fprintf(out, "seeded %d restaurants\n", len(Restaurants))
	return auth.PrintSeedTokens(out, secret, now, map[string]auth.Principal{
		"customer":   auth.SeedCustomer,
		"restaurant": auth.SeedRestaurant,
		"ops":        auth.SeedOps,
	})
}
