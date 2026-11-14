// Package idgen provides UUID generation behind an interface so tests can control it.
package idgen

import (
	"sync"

	"github.com/google/uuid"
)

// Generator returns new identifiers.
type Generator interface {
	NewID() uuid.UUID
}

// Random generates version 4 UUIDs.
type Random struct{}

// NewID returns a random UUID.
func (Random) NewID() uuid.UUID {
	return uuid.New()
}

// Sequence returns the given identifiers in order and random ones once they run out.
type Sequence struct {
	mu  sync.Mutex
	ids []uuid.UUID
}

// NewSequence returns a Sequence that yields ids first.
func NewSequence(ids ...uuid.UUID) *Sequence {
	return &Sequence{ids: ids}
}

// NewID returns the next queued identifier, or a random one.
func (s *Sequence) NewID() uuid.UUID {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.ids) == 0 {
		return uuid.New()
	}
	id := s.ids[0]
	s.ids = s.ids[1:]
	return id
}
