use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, Utc};
use rand::Rng;

/// Source of the current instant.
pub trait Clock: Send + Sync {
    /// Returns the current instant in UTC.
    fn now(&self) -> DateTime<Utc>;
}

/// Clock backed by the operating system's wall clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// Clock that returns an instant set by the caller.
#[derive(Debug)]
pub struct FixedClock {
    now: Mutex<DateTime<Utc>>,
}

impl FixedClock {
    /// Creates a clock that reports `now` until changed.
    pub fn new(now: DateTime<Utc>) -> Self {
        Self {
            now: Mutex::new(now),
        }
    }

    /// Sets the instant the clock reports.
    pub fn set(&self, now: DateTime<Utc>) {
        let mut guard = self.now.lock().unwrap_or_else(|p| p.into_inner());
        *guard = now;
    }

    /// Moves the clock forward (or backward, for a negative duration).
    pub fn advance(&self, by: Duration) {
        let mut guard = self.now.lock().unwrap_or_else(|p| p.into_inner());
        *guard += by;
    }
}

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        *self.now.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Clock that follows the database server's clock: a local clock plus a measured offset.
pub struct SyncedClock {
    local: Arc<dyn Clock>,
    offset_ms: AtomicI64,
}

impl SyncedClock {
    /// Creates a clock that reports `local` time until an offset is set.
    pub fn new(local: Arc<dyn Clock>) -> Self {
        Self {
            local,
            offset_ms: AtomicI64::new(0),
        }
    }

    /// Returns the local clock's current instant, without the offset.
    pub fn local_now(&self) -> DateTime<Utc> {
        self.local.now()
    }

    /// Returns the offset currently applied, in milliseconds.
    pub fn offset_ms(&self) -> i64 {
        self.offset_ms.load(Ordering::Relaxed)
    }

    /// Sets the offset added to local time, in milliseconds.
    pub fn set_offset_ms(&self, offset_ms: i64) {
        self.offset_ms.store(offset_ms, Ordering::Relaxed);
    }
}

impl Clock for SyncedClock {
    fn now(&self) -> DateTime<Utc> {
        self.local.now() + Duration::milliseconds(self.offset_ms())
    }
}

/// Returns the remote clock's offset from the local clock in milliseconds, given the local
/// instants a request was sent and its reply received and the remote instant it reported.
/// The remote reading is taken to correspond to the midpoint of the round trip.
pub fn estimate_offset_ms(
    sent: DateTime<Utc>,
    remote: DateTime<Utc>,
    received: DateTime<Utc>,
) -> i64 {
    let midpoint = sent + (received - sent) / 2;
    (remote - midpoint).num_milliseconds()
}

/// Source of jitter values for retry back-off.
pub trait JitterSource: Send + Sync {
    /// Returns a value in `[0, 1)`.
    fn sample(&self) -> f64;
}

/// Jitter drawn from the thread-local random number generator.
#[derive(Debug, Default, Clone, Copy)]
pub struct RandomJitter;

impl JitterSource for RandomJitter {
    fn sample(&self) -> f64 {
        rand::thread_rng().gen::<f64>()
    }
}

/// Jitter that always returns the same value.
#[derive(Debug, Clone, Copy)]
pub struct FixedJitter(pub f64);

impl JitterSource for FixedJitter {
    fn sample(&self) -> f64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn fixed_clock_can_be_set_and_advanced() {
        let start = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let clock = FixedClock::new(start);
        assert_eq!(clock.now(), start);
        clock.advance(Duration::seconds(90));
        assert_eq!(clock.now(), start + Duration::seconds(90));
        clock.set(start);
        assert_eq!(clock.now(), start);
    }

    #[test]
    fn random_jitter_stays_in_unit_interval() {
        let jitter = RandomJitter;
        for _ in 0..1000 {
            let r = jitter.sample();
            assert!((0.0..1.0).contains(&r));
        }
    }

    #[test]
    fn offset_uses_the_round_trip_midpoint() {
        let sent = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let received = sent + Duration::milliseconds(100);
        let remote = sent + Duration::milliseconds(50);
        assert_eq!(estimate_offset_ms(sent, remote, received), 0);
        let remote = sent + Duration::milliseconds(1050);
        assert_eq!(estimate_offset_ms(sent, remote, received), 1000);
    }

    #[test]
    fn synced_clock_corrects_a_fast_local_clock() {
        let true_now = Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap();
        let local = Arc::new(FixedClock::new(true_now + Duration::minutes(10)));
        let synced = SyncedClock::new(local.clone());
        assert_eq!(synced.now(), true_now + Duration::minutes(10));

        let sent = synced.local_now();
        let received = sent + Duration::milliseconds(20);
        let remote = true_now + Duration::milliseconds(10);
        synced.set_offset_ms(estimate_offset_ms(sent, remote, received));
        assert_eq!(synced.offset_ms(), -600_000);
        assert_eq!(synced.now(), true_now);

        local.advance(Duration::seconds(30));
        assert_eq!(synced.now(), true_now + Duration::seconds(30));
    }
}
