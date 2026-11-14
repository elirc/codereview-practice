//! What happens to a running job when its handler fails or its lease runs out.

use crate::state::{AttemptOutcome, DeadReason, JobState};

/// Error message recorded when a handler panics.
pub const HANDLER_PANICKED: &str = "handler panicked";

/// Error message recorded when a handler stops without a cancellation request.
pub const CANCELLED_WITHOUT_REQUEST: &str = "cancelled without request";

/// Error message recorded when a handler's result exceeds the size limit.
pub const RESULT_TOO_LARGE: &str = "result_too_large";

/// The kind of error a handler returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    Retryable,
    Permanent,
    Cancelled,
}

/// The state a failed or expired job moves to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NextState {
    /// Back to `pending` after the back-off delay.
    Retry,
    Dead(DeadReason),
    Cancelled,
}

impl NextState {
    /// Returns the job state this transition leads to.
    pub fn job_state(self) -> JobState {
        match self {
            Self::Retry => JobState::Pending,
            Self::Dead(_) => JobState::Dead,
            Self::Cancelled => JobState::Cancelled,
        }
    }

    /// Returns the dead reason, if the job becomes dead.
    pub fn dead_reason(self) -> Option<DeadReason> {
        match self {
            Self::Dead(reason) => Some(reason),
            _ => None,
        }
    }
}

/// Result of [`decide_failure`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailureDecision {
    pub next: NextState,
    pub attempt_outcome: AttemptOutcome,
    pub message: String,
}

/// Decides the next state of a running job whose handler returned an error.
///
/// `attempt` is the job's current attempt number (the claim that failed).
pub fn decide_failure(
    kind: FailureKind,
    message: &str,
    cancel_requested: bool,
    attempt: i32,
    max_attempts: i32,
) -> FailureDecision {
    match kind {
        FailureKind::Permanent => FailureDecision {
            next: NextState::Dead(DeadReason::PermanentFailure),
            attempt_outcome: AttemptOutcome::PermanentError,
            message: message.to_string(),
        },
        FailureKind::Cancelled if cancel_requested => FailureDecision {
            next: NextState::Cancelled,
            attempt_outcome: AttemptOutcome::Cancelled,
            message: message.to_string(),
        },
        FailureKind::Cancelled => FailureDecision {
            next: retry_or_exhausted(false, attempt, max_attempts),
            attempt_outcome: AttemptOutcome::RetryableError,
            message: CANCELLED_WITHOUT_REQUEST.to_string(),
        },
        FailureKind::Retryable => FailureDecision {
            next: retry_or_exhausted(cancel_requested, attempt, max_attempts),
            attempt_outcome: AttemptOutcome::RetryableError,
            message: message.to_string(),
        },
    }
}

fn retry_or_exhausted(cancel_requested: bool, attempt: i32, max_attempts: i32) -> NextState {
    if cancel_requested {
        NextState::Cancelled
    } else if attempt >= max_attempts {
        NextState::Dead(DeadReason::AttemptsExhausted)
    } else {
        NextState::Retry
    }
}

/// Decides the next state of a running job whose lease has expired.
pub fn decide_lease_expiry(cancel_requested: bool, attempt: i32, max_attempts: i32) -> NextState {
    if cancel_requested {
        NextState::Cancelled
    } else if attempt >= max_attempts {
        NextState::Dead(DeadReason::LeaseExpired)
    } else {
        NextState::Retry
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permanent_goes_dead_even_with_attempts_left() {
        let d = decide_failure(FailureKind::Permanent, "bad input", false, 1, 5);
        assert_eq!(d.next, NextState::Dead(DeadReason::PermanentFailure));
        assert_eq!(d.attempt_outcome, AttemptOutcome::PermanentError);
        assert_eq!(d.message, "bad input");
        let d = decide_failure(FailureKind::Permanent, "bad input", true, 1, 5);
        assert_eq!(d.next.job_state(), JobState::Dead);
    }

    #[test]
    fn retryable_retries_until_the_last_attempt() {
        assert_eq!(
            decide_failure(FailureKind::Retryable, "e", false, 1, 3).next,
            NextState::Retry
        );
        assert_eq!(
            decide_failure(FailureKind::Retryable, "e", false, 2, 3).next,
            NextState::Retry
        );
        let last = decide_failure(FailureKind::Retryable, "e", false, 3, 3);
        assert_eq!(last.next, NextState::Dead(DeadReason::AttemptsExhausted));
        assert_eq!(last.next.dead_reason(), Some(DeadReason::AttemptsExhausted));
    }

    #[test]
    fn retryable_with_cancel_requested_is_cancelled() {
        let d = decide_failure(FailureKind::Retryable, "e", true, 1, 3);
        assert_eq!(d.next, NextState::Cancelled);
        let d = decide_failure(FailureKind::Retryable, "e", true, 3, 3);
        assert_eq!(d.next, NextState::Cancelled);
    }

    #[test]
    fn cancelled_with_request_is_cancelled() {
        let d = decide_failure(FailureKind::Cancelled, "stopped", true, 1, 3);
        assert_eq!(d.next, NextState::Cancelled);
        assert_eq!(d.attempt_outcome, AttemptOutcome::Cancelled);
    }

    #[test]
    fn cancelled_without_request_is_treated_as_retryable() {
        let d = decide_failure(FailureKind::Cancelled, "stopped", false, 1, 3);
        assert_eq!(d.next, NextState::Retry);
        assert_eq!(d.attempt_outcome, AttemptOutcome::RetryableError);
        assert_eq!(d.message, CANCELLED_WITHOUT_REQUEST);
        let d = decide_failure(FailureKind::Cancelled, "stopped", false, 3, 3);
        assert_eq!(d.next, NextState::Dead(DeadReason::AttemptsExhausted));
    }

    #[test]
    fn lease_expiry_table() {
        assert_eq!(decide_lease_expiry(false, 1, 3), NextState::Retry);
        assert_eq!(
            decide_lease_expiry(false, 3, 3),
            NextState::Dead(DeadReason::LeaseExpired)
        );
        assert_eq!(decide_lease_expiry(true, 1, 3), NextState::Cancelled);
        assert_eq!(decide_lease_expiry(true, 3, 3), NextState::Cancelled);
    }

    #[test]
    fn next_state_maps_to_job_states() {
        assert_eq!(NextState::Retry.job_state(), JobState::Pending);
        assert_eq!(NextState::Cancelled.job_state(), JobState::Cancelled);
        assert_eq!(NextState::Retry.dead_reason(), None);
    }
}
