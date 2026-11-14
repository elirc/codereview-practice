// Package clock provides the time source used by domain code, loops and handlers.
package clock

import (
	"sync"
	"time"
)

// Clock reports the current instant.
type Clock interface {
	Now() time.Time
}

// System is the wall clock, reported in UTC.
type System struct{}

// Now returns the current wall-clock time in UTC.
func (System) Now() time.Time {
	return time.Now().UTC()
}

// Manual is a clock that only moves when told to. It is safe for concurrent use.
type Manual struct {
	mu  sync.Mutex
	now time.Time
}

// NewManual returns a Manual clock set to t.
func NewManual(t time.Time) *Manual {
	return &Manual{now: t.UTC()}
}

// Now returns the clock's current instant.
func (m *Manual) Now() time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.now
}

// Set moves the clock to t.
func (m *Manual) Set(t time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.now = t.UTC()
}

// Advance moves the clock forward by d and returns the new instant.
func (m *Manual) Advance(d time.Duration) time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.now = m.now.Add(d)
	return m.now
}
