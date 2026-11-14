// Command devtoken mints a bearer token for local development.
//
//	AUTH_JWT_SECRET=... devtoken -role courier -sub <uuid> [-restaurant <uuid>] [-ttl 24h]
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/google/uuid"

	"deliverydispatch/pkg/auth"
	"deliverydispatch/pkg/clock"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "devtoken:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	fs := flag.NewFlagSet("devtoken", flag.ContinueOnError)
	role := fs.String("role", "", "customer, restaurant, courier or ops")
	sub := fs.String("sub", "", "subject UUID (default: random)")
	restaurant := fs.String("restaurant", "", "restaurant UUID, required for the restaurant role")
	ttl := fs.Duration("ttl", 24*time.Hour, "token lifetime")
	if err := fs.Parse(args); err != nil {
		return err
	}
	secret := os.Getenv("AUTH_JWT_SECRET")
	if len(secret) < 32 {
		return errors.New("AUTH_JWT_SECRET must be set to at least 32 bytes")
	}
	p := auth.Principal{Role: auth.Role(*role)}
	if !p.Role.Valid() {
		return fmt.Errorf("unknown role %q", *role)
	}
	p.Subject = uuid.New()
	if *sub != "" {
		id, err := uuid.Parse(*sub)
		if err != nil {
			return fmt.Errorf("-sub: %w", err)
		}
		p.Subject = id
	}
	if *restaurant != "" {
		id, err := uuid.Parse(*restaurant)
		if err != nil {
			return fmt.Errorf("-restaurant: %w", err)
		}
		p.RestaurantID = uuid.NullUUID{UUID: id, Valid: true}
	}
	if p.Role == auth.RoleRestaurant && !p.RestaurantID.Valid {
		return errors.New("-restaurant is required for the restaurant role")
	}
	tok, err := auth.Mint([]byte(secret), p, clock.System{}.Now().Add(*ttl))
	if err != nil {
		return err
	}
	fmt.Println(tok)
	return nil
}
