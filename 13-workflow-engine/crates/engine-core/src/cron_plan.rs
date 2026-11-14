//! Cron expression parsing and planning which jobs a due schedule creates.

use std::collections::VecDeque;
use std::fmt;
use std::str::FromStr;

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use cron::Schedule;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::state::UnknownVariant;

/// How far back missed fire times are considered.
pub const CATCHUP_HORIZON_HOURS: i64 = 24;
/// How late a fire may be and still count as on time.
pub const MISFIRE_GRACE_SECONDS: i64 = 60;
/// Gap between the jobs of one catch-up.
pub const CATCHUP_SPACING_SECONDS: i64 = 5;
/// Range of the per-schedule offset applied to catch-up jobs.
pub const CATCHUP_STAGGER_SECONDS: u32 = 30;

/// What a schedule does about fire times that passed while nothing was running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatchupPolicy {
    Skip,
    Latest,
    All,
}

impl CatchupPolicy {
    pub const ALL: [CatchupPolicy; 3] = [
        CatchupPolicy::Skip,
        CatchupPolicy::Latest,
        CatchupPolicy::All,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Skip => "skip",
            Self::Latest => "latest",
            Self::All => "all",
        }
    }
}

impl FromStr for CatchupPolicy {
    type Err = UnknownVariant;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|p| p.as_str() == s)
            .ok_or_else(|| UnknownVariant {
                kind: "catch-up policy",
                value: s.to_string(),
            })
    }
}

impl fmt::Display for CatchupPolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Parses a six- or seven-field cron expression (seconds first, UTC).
pub fn parse_cron(expr: &str) -> Result<Schedule, String> {
    Schedule::from_str(expr.trim()).map_err(|e| e.to_string())
}

/// Returns the first fire time strictly after `after`, if the schedule fires again.
pub fn next_fire_after(schedule: &Schedule, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    schedule.after(&after).next()
}

/// Returns the schedule's offset for catch-up jobs: its id's first four bytes, read as an
/// unsigned big-endian integer, modulo [`CATCHUP_STAGGER_SECONDS`].
pub fn stagger_seconds(schedule_id: Uuid) -> i64 {
    let b = schedule_id.as_bytes();
    i64::from(u32::from_be_bytes([b[0], b[1], b[2], b[3]]) % CATCHUP_STAGGER_SECONDS)
}

/// Returns the unique key of the job created for `schedule_id` at fire time `fire`.
pub fn schedule_unique_key(schedule_id: Uuid, fire: DateTime<Utc>) -> String {
    format!(
        "schedule:{schedule_id}:{}",
        fire.to_rfc3339_opts(SecondsFormat::Secs, true)
    )
}

/// One job a schedule pass creates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlannedFire {
    pub scheduled_for: DateTime<Utc>,
    pub run_at: DateTime<Utc>,
}

/// What a schedule pass does: the jobs to create and the schedule's new fire times.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirePlan {
    pub fires: Vec<PlannedFire>,
    /// The latest due fire time, when any was due inside the horizon.
    pub last_fire_at: Option<DateTime<Utc>>,
    /// The first fire time strictly after `now`; `None` when the schedule never fires again.
    pub next_fire_at: Option<DateTime<Utc>>,
}

/// Plans a pass for a schedule whose `next_fire_at` is at or before `now`.
///
/// Due fire times are `next_fire_at` and every later fire time up to `now`, ignoring those
/// older than [`CATCHUP_HORIZON_HOURS`]. The policy then picks which of them get a job.
pub fn plan_fires(
    schedule: &Schedule,
    policy: CatchupPolicy,
    max_catchup: i32,
    next_fire_at: DateTime<Utc>,
    now: DateTime<Utc>,
    schedule_id: Uuid,
) -> FirePlan {
    let horizon_start = now - Duration::hours(CATCHUP_HORIZON_HOURS);
    let keep = match policy {
        CatchupPolicy::All => usize::try_from(max_catchup.max(1)).unwrap_or(1),
        CatchupPolicy::Skip | CatchupPolicy::Latest => 1,
    };

    let mut latest: VecDeque<DateTime<Utc>> = VecDeque::with_capacity(keep + 1);
    let mut remember = |t: DateTime<Utc>| {
        latest.push_back(t);
        if latest.len() > keep {
            latest.pop_front();
        }
    };
    let search_from = if next_fire_at >= horizon_start {
        if next_fire_at <= now {
            remember(next_fire_at);
        }
        next_fire_at
    } else {
        horizon_start - Duration::milliseconds(1)
    };
    for t in schedule.after(&search_from) {
        if t > now {
            break;
        }
        remember(t);
    }

    let next = next_fire_after(schedule, now);
    let Some(&newest) = latest.back() else {
        return FirePlan {
            fires: Vec::new(),
            last_fire_at: None,
            next_fire_at: next,
        };
    };

    let on_time = now - newest <= Duration::seconds(MISFIRE_GRACE_SECONDS);
    let chosen: Vec<DateTime<Utc>> = match policy {
        CatchupPolicy::Skip if on_time => vec![newest],
        CatchupPolicy::Skip => Vec::new(),
        CatchupPolicy::Latest => vec![newest],
        CatchupPolicy::All => latest.into_iter().collect(),
    };
    let immediate = on_time && chosen.len() == 1;
    let stagger = stagger_seconds(schedule_id);
    let fires = chosen
        .into_iter()
        .enumerate()
        .map(|(i, scheduled_for)| {
            let run_at = if immediate {
                now
            } else {
                let offset = stagger + i as i64 * CATCHUP_SPACING_SECONDS;
                now + Duration::seconds(offset)
            };
            PlannedFire {
                scheduled_for,
                run_at,
            }
        })
        .collect();

    FirePlan {
        fires,
        last_fire_at: Some(newest),
        next_fire_at: next,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(h: u32, m: u32, s: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, 5, h, m, s).unwrap()
    }

    fn every_five_minutes() -> Schedule {
        parse_cron("0 */5 * * * *").unwrap()
    }

    fn id_with_stagger(first_four: [u8; 4]) -> Uuid {
        let mut bytes = [0_u8; 16];
        bytes[..4].copy_from_slice(&first_four);
        Uuid::from_bytes(bytes)
    }

    #[test]
    fn parses_six_and_seven_fields_and_day_names() {
        assert!(parse_cron("0 */5 * * * *").is_ok());
        assert!(parse_cron("0 0 9 * * Mon-Fri").is_ok());
        assert!(parse_cron("0 0 9 * * * 2030").is_ok());
        assert!(parse_cron("not cron").is_err());
        assert!(parse_cron("0 61 * * * *").is_err());
    }

    #[test]
    fn next_fire_is_strictly_after() {
        let s = every_five_minutes();
        assert_eq!(next_fire_after(&s, at(12, 0, 0)), Some(at(12, 5, 0)));
        assert_eq!(next_fire_after(&s, at(12, 4, 59)), Some(at(12, 5, 0)));
        let weekdays = parse_cron("0 0 9 * * Mon-Fri").unwrap();
        // 2026-01-09 is a Friday; the next weekday 09:00 is Monday the 12th.
        let friday_evening = Utc.with_ymd_and_hms(2026, 1, 9, 18, 0, 0).unwrap();
        assert_eq!(
            next_fire_after(&weekdays, friday_evening),
            Some(Utc.with_ymd_and_hms(2026, 1, 12, 9, 0, 0).unwrap())
        );
    }

    #[test]
    fn on_time_fire_runs_now_under_every_policy() {
        let s = every_five_minutes();
        let now = at(12, 5, 30);
        for policy in CatchupPolicy::ALL {
            let plan = plan_fires(&s, policy, 10, at(12, 5, 0), now, Uuid::nil());
            assert_eq!(
                plan.fires,
                vec![PlannedFire {
                    scheduled_for: at(12, 5, 0),
                    run_at: now
                }],
                "{policy}"
            );
            assert_eq!(plan.last_fire_at, Some(at(12, 5, 0)));
            assert_eq!(plan.next_fire_at, Some(at(12, 10, 0)));
        }
    }

    #[test]
    fn a_fire_61_seconds_late_is_skipped_by_skip() {
        let s = every_five_minutes();
        let now = at(12, 6, 1);
        let plan = plan_fires(&s, CatchupPolicy::Skip, 10, at(12, 5, 0), now, Uuid::nil());
        assert!(plan.fires.is_empty());
        assert_eq!(plan.last_fire_at, Some(at(12, 5, 0)));
        assert_eq!(plan.next_fire_at, Some(at(12, 10, 0)));

        let plan = plan_fires(&s, CatchupPolicy::Latest, 10, at(12, 5, 0), now, Uuid::nil());
        assert_eq!(plan.fires.len(), 1);
        assert_eq!(plan.fires[0].run_at, now);
    }

    #[test]
    fn catch_up_after_three_hours_of_downtime() {
        let s = every_five_minutes();
        let now = at(15, 2, 30);
        let id = id_with_stagger([0, 0, 0, 7]);

        let skip = plan_fires(&s, CatchupPolicy::Skip, 10, at(12, 5, 0), now, id);
        assert!(skip.fires.is_empty());
        assert_eq!(skip.next_fire_at, Some(at(15, 5, 0)));
        assert_eq!(skip.last_fire_at, Some(at(15, 0, 0)));

        let latest = plan_fires(&s, CatchupPolicy::Latest, 10, at(12, 5, 0), now, id);
        assert_eq!(
            latest.fires,
            vec![PlannedFire {
                scheduled_for: at(15, 0, 0),
                run_at: now + Duration::seconds(7)
            }]
        );

        let all = plan_fires(&s, CatchupPolicy::All, 10, at(12, 5, 0), now, id);
        assert_eq!(all.fires.len(), 10);
        assert_eq!(all.fires[0].scheduled_for, at(14, 15, 0));
        assert_eq!(all.fires[9].scheduled_for, at(15, 0, 0));
        for (i, fire) in all.fires.iter().enumerate() {
            assert_eq!(fire.run_at, now + Duration::seconds(7 + 5 * i as i64));
        }
        assert_eq!(all.next_fire_at, Some(at(15, 5, 0)));
    }

    #[test]
    fn all_with_fewer_due_times_than_the_cap_creates_each_once() {
        let s = every_five_minutes();
        let now = at(12, 15, 10);
        let plan = plan_fires(&s, CatchupPolicy::All, 10, at(12, 5, 0), now, Uuid::nil());
        let times: Vec<_> = plan.fires.iter().map(|f| f.scheduled_for).collect();
        assert_eq!(times, vec![at(12, 5, 0), at(12, 10, 0), at(12, 15, 0)]);
        assert_eq!(plan.fires[0].run_at, now);
        assert_eq!(plan.fires[2].run_at, now + Duration::seconds(10));
    }

    #[test]
    fn nothing_older_than_the_horizon_is_considered() {
        let every_second = parse_cron("* * * * * *").unwrap();
        let now = at(12, 0, 0);
        let week_ago = now - Duration::days(7);
        let plan = plan_fires(&every_second, CatchupPolicy::All, 100, week_ago, now, Uuid::nil());
        assert_eq!(plan.fires.len(), 100);
        let horizon = now - Duration::hours(CATCHUP_HORIZON_HOURS);
        assert!(plan.fires.iter().all(|f| f.scheduled_for >= horizon));
        assert_eq!(plan.fires[99].scheduled_for, now);
        assert_eq!(plan.next_fire_at, Some(now + Duration::seconds(1)));

        let five_minutes = every_five_minutes();
        let long_gap = plan_fires(
            &five_minutes,
            CatchupPolicy::Latest,
            10,
            now - Duration::days(3),
            now - Duration::hours(25),
            Uuid::nil(),
        );
        assert_eq!(long_gap.fires.len(), 1);
        assert!(long_gap.fires[0].scheduled_for >= now - Duration::hours(49));
    }

    #[test]
    fn stagger_comes_from_the_first_four_bytes() {
        assert_eq!(stagger_seconds(id_with_stagger([0, 0, 0, 29])), 29);
        assert_eq!(stagger_seconds(id_with_stagger([0, 0, 0, 30])), 0);
        assert_eq!(stagger_seconds(id_with_stagger([0, 0, 1, 0])), 256 % 30);
        assert_eq!(
            stagger_seconds(id_with_stagger([255, 255, 255, 255])),
            i64::from(u32::MAX % 30)
        );
    }

    #[test]
    fn unique_key_uses_rfc3339_seconds() {
        let id = Uuid::nil();
        assert_eq!(
            schedule_unique_key(id, at(12, 5, 0)),
            "schedule:00000000-0000-0000-0000-000000000000:2026-01-05T12:05:00Z"
        );
    }

    #[test]
    fn policies_parse() {
        for p in CatchupPolicy::ALL {
            assert_eq!(p.as_str().parse::<CatchupPolicy>().unwrap(), p);
        }
        assert!("sometimes".parse::<CatchupPolicy>().is_err());
    }
}
