package domain

import "time"

// Location thresholds.
const (
	MaxFutureSkew    = 30 * time.Second
	MaxLocationAge   = 5 * time.Minute
	PublishInterval  = 10 * time.Second
	PublishDistanceM = 50.0
)

// LocationVerdict classifies a reported location.
type LocationVerdict int

// Location verdicts.
const (
	LocationAccepted LocationVerdict = iota + 1
	LocationTooOld
	LocationInFuture
)

// JudgeLocation classifies a ping recorded at recordedAt and received at now:
// more than MaxFutureSkew ahead is in the future, more than MaxLocationAge
// old is too old, anything else is accepted.
func JudgeLocation(recordedAt, now time.Time) LocationVerdict {
	switch {
	case recordedAt.Sub(now) > MaxFutureSkew:
		return LocationInFuture
	case now.Sub(recordedAt) > MaxLocationAge:
		return LocationTooOld
	default:
		return LocationAccepted
	}
}

// ShouldReplacePosition reports whether a ping recorded at recordedAt replaces
// the stored position recorded at storedAt (nil when none is stored).
func ShouldReplacePosition(storedAt *time.Time, recordedAt time.Time) bool {
	return storedAt == nil || recordedAt.After(*storedAt)
}

// ShouldPublishLocation reports whether a stored ping is published: the
// courier is on shift and either nothing was published yet, the last
// publication is at least PublishInterval older, or the point is at least
// PublishDistanceM from the published one.
func ShouldPublishLocation(onShift bool, publishedAt *time.Time, recordedAt time.Time, distanceFromPublishedM float64) bool {
	if !onShift {
		return false
	}
	if publishedAt == nil {
		return true
	}
	return recordedAt.Sub(*publishedAt) >= PublishInterval || distanceFromPublishedM >= PublishDistanceM
}
