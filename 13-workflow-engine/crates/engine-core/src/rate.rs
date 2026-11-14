//! Token bucket and claim allowance arithmetic.

use chrono::{DateTime, Duration, Utc};

/// Stored state of a queue's token bucket. One token is 1000 milli-tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bucket {
    pub tokens_milli: i64,
    pub refilled_at: DateTime<Utc>,
}

/// Returns the bucket refilled up to `now` for a rate of `per_minute` tokens and a capacity of
/// `burst` tokens.
///
/// A `now` earlier than `refilled_at` adds nothing and leaves `refilled_at` unchanged. Below
/// capacity, `refilled_at` advances only by the time that produced whole milli-tokens, so the
/// remainder carries over to the next refill.
pub fn refill(bucket: Bucket, per_minute: i32, burst: i32, now: DateTime<Utc>) -> Bucket {
    let per_minute = i64::from(per_minute.max(1));
    let capacity = i64::from(burst.max(1)).saturating_mul(1000);
    let elapsed_ms = (now - bucket.refilled_at).num_milliseconds();
    if elapsed_ms <= 0 {
        return Bucket {
            tokens_milli: bucket.tokens_milli.min(capacity),
            refilled_at: bucket.refilled_at,
        };
    }
    let added = elapsed_ms.saturating_mul(per_minute) / 60;
    let total = bucket.tokens_milli.saturating_add(added);
    if total >= capacity {
        return Bucket {
            tokens_milli: capacity,
            refilled_at: now,
        };
    }
    let produced = added.saturating_mul(60);
    let accounted_ms = produced / per_minute + i64::from(produced % per_minute != 0);
    Bucket {
        tokens_milli: total,
        refilled_at: bucket.refilled_at + Duration::milliseconds(accounted_ms),
    }
}

/// Returns the bucket after `claimed` jobs have started.
pub fn consume(bucket: Bucket, claimed: i64) -> Bucket {
    Bucket {
        tokens_milli: bucket
            .tokens_milli
            .saturating_sub(claimed.saturating_mul(1000))
            .max(0),
        refilled_at: bucket.refilled_at,
    }
}

/// Returns how many jobs a claim may start: at most `limit`, no more than the free
/// concurrency slots, and no more than the whole tokens available. Never negative.
pub fn allowance(
    limit: i64,
    max_concurrency: Option<i32>,
    running: i64,
    tokens_milli: Option<i64>,
) -> i64 {
    let mut allowed = limit;
    if let Some(max) = max_concurrency {
        allowed = allowed.min(i64::from(max) - running);
    }
    if let Some(tokens) = tokens_milli {
        allowed = allowed.min(tokens / 1000);
    }
    allowed.max(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn t0() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap()
    }

    fn ms(n: i64) -> Duration {
        Duration::milliseconds(n)
    }

    #[test]
    fn refills_at_the_configured_rate() {
        let empty = Bucket {
            tokens_milli: 0,
            refilled_at: t0(),
        };
        let b = refill(empty, 60, 10, t0() + ms(1000));
        assert_eq!(b.tokens_milli, 1000);
        assert_eq!(b.refilled_at, t0() + ms(1000));
        let b = refill(empty, 60, 10, t0() + ms(2500));
        assert_eq!(b.tokens_milli, 2500);
    }

    #[test]
    fn refill_is_capped_at_the_burst() {
        let empty = Bucket {
            tokens_milli: 0,
            refilled_at: t0(),
        };
        let b = refill(empty, 60, 10, t0() + Duration::minutes(5));
        assert_eq!(b.tokens_milli, 10_000);
        assert_eq!(b.refilled_at, t0() + Duration::minutes(5));
    }

    #[test]
    fn backward_clock_adds_nothing_and_keeps_refilled_at() {
        let bucket = Bucket {
            tokens_milli: 3000,
            refilled_at: t0(),
        };
        let b = refill(bucket, 60, 10, t0() - Duration::seconds(30));
        assert_eq!(b, bucket);
    }

    #[test]
    fn slow_rates_accumulate_across_frequent_refills() {
        let mut bucket = Bucket {
            tokens_milli: 0,
            refilled_at: t0(),
        };
        // One token per minute, refilled every 10 ms for a minute.
        for step in 1..=6000 {
            bucket = refill(bucket, 1, 5, t0() + ms(step * 10));
        }
        assert_eq!(bucket.tokens_milli, 1000);
    }

    #[test]
    fn remainder_is_not_over_credited() {
        let empty = Bucket {
            tokens_milli: 0,
            refilled_at: t0(),
        };
        // 7 per minute: 1 ms adds 0.1166 milli-tokens, 100 ms adds 11.
        let b = refill(empty, 7, 10, t0() + ms(100));
        assert_eq!(b.tokens_milli, 11);
        assert!(b.refilled_at <= t0() + ms(100));
        assert!(b.refilled_at >= t0() + ms(94));
    }

    #[test]
    fn consume_subtracts_whole_tokens() {
        let bucket = Bucket {
            tokens_milli: 2500,
            refilled_at: t0(),
        };
        assert_eq!(consume(bucket, 2).tokens_milli, 500);
        assert_eq!(consume(bucket, 5).tokens_milli, 0);
    }

    #[test]
    fn allowance_takes_the_tightest_limit() {
        assert_eq!(allowance(5, None, 0, None), 5);
        assert_eq!(allowance(5, Some(2), 0, None), 2);
        assert_eq!(allowance(5, Some(2), 1, None), 1);
        assert_eq!(allowance(5, Some(2), 3, None), 0);
        assert_eq!(allowance(5, None, 0, Some(2999)), 2);
        assert_eq!(allowance(5, Some(4), 1, Some(10_000)), 3);
        assert_eq!(allowance(0, None, 0, None), 0);
    }
}
