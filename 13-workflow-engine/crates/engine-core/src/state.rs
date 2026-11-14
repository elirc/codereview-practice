//! Enumerations stored as text columns, with their string forms.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// Error returned when a stored or submitted string is not a known variant.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown {kind} {value:?}")]
pub struct UnknownVariant {
    pub kind: &'static str,
    pub value: String,
}

fn unknown(kind: &'static str, value: &str) -> UnknownVariant {
    UnknownVariant {
        kind,
        value: value.to_string(),
    }
}

/// Lifecycle state of a job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Pending,
    Running,
    Succeeded,
    Dead,
    Cancelled,
}

impl JobState {
    pub const ALL: [JobState; 5] = [
        JobState::Pending,
        JobState::Running,
        JobState::Succeeded,
        JobState::Dead,
        JobState::Cancelled,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Dead => "dead",
            Self::Cancelled => "cancelled",
        }
    }

    /// Returns true for states a job never leaves on its own.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Dead | Self::Cancelled)
    }
}

impl FromStr for JobState {
    type Err = UnknownVariant;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|v| v.as_str() == s)
            .ok_or_else(|| unknown("job state", s))
    }
}

impl fmt::Display for JobState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Why a job ended up dead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeadReason {
    AttemptsExhausted,
    PermanentFailure,
    LeaseExpired,
}

impl DeadReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AttemptsExhausted => "attempts_exhausted",
            Self::PermanentFailure => "permanent_failure",
            Self::LeaseExpired => "lease_expired",
        }
    }
}

/// How one claim of a job ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptOutcome {
    Succeeded,
    RetryableError,
    PermanentError,
    LeaseExpired,
    Released,
    Cancelled,
}

impl AttemptOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::RetryableError => "retryable_error",
            Self::PermanentError => "permanent_error",
            Self::LeaseExpired => "lease_expired",
            Self::Released => "released",
            Self::Cancelled => "cancelled",
        }
    }
}

/// State of one step in a workflow run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Blocked,
    Queued,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
}

impl StepState {
    pub const ALL: [StepState; 6] = [
        StepState::Blocked,
        StepState::Queued,
        StepState::Succeeded,
        StepState::Failed,
        StepState::Skipped,
        StepState::Cancelled,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Blocked => "blocked",
            Self::Queued => "queued",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
            Self::Cancelled => "cancelled",
        }
    }
}

impl FromStr for StepState {
    type Err = UnknownVariant;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|v| v.as_str() == s)
            .ok_or_else(|| unknown("step state", s))
    }
}

/// State of a workflow run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl RunState {
    pub const ALL: [RunState; 4] = [
        RunState::Running,
        RunState::Succeeded,
        RunState::Failed,
        RunState::Cancelled,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

impl FromStr for RunState {
    type Err = UnknownVariant;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|v| v.as_str() == s)
            .ok_or_else(|| unknown("run state", s))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_states_round_trip_through_strings() {
        for state in JobState::ALL {
            assert_eq!(state.as_str().parse::<JobState>().unwrap(), state);
        }
        assert!("paused".parse::<JobState>().is_err());
    }

    #[test]
    fn terminal_job_states() {
        assert!(!JobState::Pending.is_terminal());
        assert!(!JobState::Running.is_terminal());
        assert!(JobState::Succeeded.is_terminal());
        assert!(JobState::Dead.is_terminal());
        assert!(JobState::Cancelled.is_terminal());
    }

    #[test]
    fn step_and_run_states_round_trip() {
        for state in StepState::ALL {
            assert_eq!(state.as_str().parse::<StepState>().unwrap(), state);
        }
        for state in RunState::ALL {
            assert_eq!(state.as_str().parse::<RunState>().unwrap(), state);
        }
    }

    #[test]
    fn serde_uses_snake_case() {
        let json = serde_json::to_string(&AttemptOutcome::RetryableError).unwrap();
        assert_eq!(json, "\"retryable_error\"");
        assert_eq!(
            serde_json::to_string(&DeadReason::LeaseExpired).unwrap(),
            "\"lease_expired\""
        );
    }
}
