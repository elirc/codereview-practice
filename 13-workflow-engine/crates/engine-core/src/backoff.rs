//! Retry delay computation.

use chrono::Duration;

/// Returns the retry delay in milliseconds after attempt number `attempt` (1-based).
///
/// The raw delay is `base_ms × 2^min(attempt − 1, 30)`, multiplied by `0.8 + 0.4 × r` and then
/// capped at `cap_ms`. `r` is expected in `[0, 1)`; values outside are clamped. All arithmetic
/// saturates.
pub fn backoff_ms(attempt: i32, base_ms: i64, cap_ms: i64, r: f64) -> i64 {
    let exponent = attempt.saturating_sub(1).clamp(0, 30) as u32;
    let raw = base_ms.max(0).saturating_mul(1_i64 << exponent);
    let r = if r.is_finite() { r.clamp(0.0, 1.0) } else { 0.0 };
    let jittered = raw as f64 * (0.8 + 0.4 * r);
    let capped = jittered.min(cap_ms.max(0) as f64);
    capped as i64
}

/// Returns [`backoff_ms`] as a duration.
pub fn backoff(attempt: i32, base_ms: i64, cap_ms: i64, r: f64) -> Duration {
    Duration::milliseconds(backoff_ms(attempt, base_ms, cap_ms, r))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAP: i64 = 3_600_000;

    #[test]
    fn doubles_from_the_base_with_neutral_jitter() {
        let delays: Vec<i64> = (1..=5).map(|n| backoff_ms(n, 1000, CAP, 0.5)).collect();
        assert_eq!(delays, vec![1000, 2000, 4000, 8000, 16000]);
    }

    #[test]
    fn large_attempts_hit_the_cap() {
        assert_eq!(backoff_ms(20, 1000, CAP, 0.5), CAP);
        assert_eq!(backoff_ms(31, 1000, CAP, 0.5), CAP);
    }

    #[test]
    fn huge_attempt_numbers_do_not_overflow() {
        assert_eq!(backoff_ms(i32::MAX, 1000, CAP, 0.5), CAP);
        assert_eq!(backoff_ms(i32::MAX, i64::MAX, i64::MAX, 0.99), i64::MAX);
    }

    #[test]
    fn zero_jitter_gives_eighty_percent() {
        assert_eq!(backoff_ms(1, 1000, CAP, 0.0), 800);
        assert_eq!(backoff_ms(3, 1000, CAP, 0.0), 3200);
    }

    #[test]
    fn jitter_close_to_one_stays_just_under_one_hundred_twenty_percent() {
        let high = backoff_ms(1, 1_000_000, CAP, 0.999_999);
        assert!(high < 1_200_000);
        assert!(high >= 1_199_999);
    }

    #[test]
    fn cap_applies_after_jitter() {
        // Raw 4000 ms; jitter would take it to about 4784 ms.
        assert_eq!(backoff_ms(3, 1000, 4500, 0.99), 4500);
        assert_eq!(backoff_ms(3, 1000, 4500, 0.0), 3200);
    }

    #[test]
    fn zero_or_negative_attempt_is_treated_as_first() {
        assert_eq!(backoff_ms(0, 1000, CAP, 0.5), 1000);
        assert_eq!(backoff_ms(-5, 1000, CAP, 0.5), 1000);
    }

    #[test]
    fn duration_wrapper_matches_milliseconds() {
        assert_eq!(backoff(2, 1000, CAP, 0.5), Duration::milliseconds(2000));
    }
}
