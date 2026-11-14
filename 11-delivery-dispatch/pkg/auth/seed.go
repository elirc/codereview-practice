package auth

import (
	"fmt"
	"io"
	"sort"
	"time"

	"github.com/google/uuid"
)

// Seed principals shared by the seed commands and the README.
var (
	SeedCustomer      = Principal{Subject: uuid.MustParse("11111111-1111-4111-8111-111111111111"), Role: RoleCustomer}
	SeedRestaurantID  = uuid.MustParse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	SeedRestaurant    = Principal{Subject: uuid.MustParse("22222222-2222-4222-8222-222222222222"), Role: RoleRestaurant, RestaurantID: uuid.NullUUID{UUID: SeedRestaurantID, Valid: true}}
	SeedOps           = Principal{Subject: uuid.MustParse("33333333-3333-4333-8333-333333333333"), Role: RoleOps}
	SeedCourierIDs    = []uuid.UUID{uuid.MustParse("cccccccc-cccc-4ccc-8ccc-000000000001"), uuid.MustParse("cccccccc-cccc-4ccc-8ccc-000000000002"), uuid.MustParse("cccccccc-cccc-4ccc-8ccc-000000000003")}
	SeedTokenLifetime = 30 * 24 * time.Hour
)

// PrintSeedTokens writes a labelled token for each principal to w.
func PrintSeedTokens(w io.Writer, secret []byte, now time.Time, labelled map[string]Principal) error {
	for _, label := range sortedKeys(labelled) {
		tok, err := Mint(secret, labelled[label], now.Add(SeedTokenLifetime))
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "%-12s %s\n", label, tok); err != nil {
			return err
		}
	}
	return nil
}

func sortedKeys(m map[string]Principal) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
