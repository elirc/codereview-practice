package store

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"rentalmanager/internal/calendar"
)

// Date converts a civil date to a pgtype.Date.
func Date(d calendar.Date) pgtype.Date {
	return pgtype.Date{Time: time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC), Valid: true}
}

// OptionalDate converts a possibly absent civil date.
func OptionalDate(d *calendar.Date) pgtype.Date {
	if d == nil {
		return pgtype.Date{}
	}
	return Date(*d)
}

// ToDate converts a non-null pgtype.Date to a civil date. pgx decodes dates
// as midnight UTC, so the UTC components are the stored date.
func ToDate(d pgtype.Date) calendar.Date {
	t := d.Time.UTC()
	return calendar.New(t.Year(), t.Month(), t.Day())
}

// ToOptionalDate converts a nullable pgtype.Date.
func ToOptionalDate(d pgtype.Date) *calendar.Date {
	if !d.Valid {
		return nil
	}
	v := ToDate(d)
	return &v
}

// Timestamptz wraps an instant.
func Timestamptz(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t, Valid: true}
}

// Text maps the empty string to NULL.
func Text(s string) pgtype.Text {
	if s == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: s, Valid: true}
}

// Int8 wraps a non-null bigint.
func Int8(v int64) pgtype.Int8 {
	return pgtype.Int8{Int64: v, Valid: true}
}

// ErrInvalidUUID is returned by ParseUUID.
var ErrInvalidUUID = errors.New("must be a UUID")

// ParseUUID parses the canonical 36-character textual form of a UUID.
func ParseUUID(s string) (pgtype.UUID, error) {
	if len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		return pgtype.UUID{}, ErrInvalidUUID
	}
	compact := s[0:8] + s[9:13] + s[14:18] + s[19:23] + s[24:36]
	var u pgtype.UUID
	if _, err := hex.Decode(u.Bytes[:], []byte(compact)); err != nil {
		return pgtype.UUID{}, ErrInvalidUUID
	}
	u.Valid = true
	return u, nil
}

// FormatUUID returns the canonical lower-case form of u, or "" when u is NULL.
func FormatUUID(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}
	b := u.Bytes
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// NewUUID returns a random (version 4) UUID.
func NewUUID() (pgtype.UUID, error) {
	var u pgtype.UUID
	if _, err := rand.Read(u.Bytes[:]); err != nil {
		return pgtype.UUID{}, fmt.Errorf("generating uuid: %w", err)
	}
	u.Bytes[6] = (u.Bytes[6] & 0x0f) | 0x40
	u.Bytes[8] = (u.Bytes[8] & 0x3f) | 0x80
	u.Valid = true
	return u, nil
}
