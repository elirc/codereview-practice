package domain

import "time"

// OfferOpen reports whether an offer expiring at expiresAt can still be shown
// to its courier and acted on at now.
func OfferOpen(expiresAt, now time.Time) bool {
	return !now.After(expiresAt)
}
