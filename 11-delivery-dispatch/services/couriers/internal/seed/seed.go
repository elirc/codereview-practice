// Package seed loads the couriers service's demo data.
package seed

import (
	"context"
	"fmt"
	"io"
	"time"

	"deliverydispatch/pkg/auth"
	"deliverydispatch/services/couriers/internal/service"
)

var couriers = []struct {
	name    string
	vehicle string
}{
	{"Tunde Bike", "bike"},
	{"Amaka Scooter", "scooter"},
	{"Chidi Car", "car"},
}

// Run creates or updates the seed couriers through svc, so each records a
// status event, and prints a token for each and for ops.
func Run(ctx context.Context, svc *service.Service, secret []byte, now time.Time, out io.Writer) error {
	tokens := map[string]auth.Principal{"ops": auth.SeedOps}
	for i, c := range couriers {
		id := auth.SeedCourierIDs[i]
		if _, err := svc.SeedCourier(ctx, id, c.name, c.vehicle); err != nil {
			return fmt.Errorf("seed courier %s: %w", c.name, err)
		}
		tokens[fmt.Sprintf("courier-%d", i+1)] = auth.Principal{Subject: id, Role: auth.RoleCourier}
	}
	fmt.Fprintf(out, "seeded %d couriers\n", len(couriers))
	return auth.PrintSeedTokens(out, secret, now, tokens)
}
