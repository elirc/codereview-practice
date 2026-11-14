use std::sync::Mutex;

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
}
