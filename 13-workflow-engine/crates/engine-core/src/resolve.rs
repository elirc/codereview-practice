//! Working out a workflow run's final state from its steps.

use crate::state::{RunState, StepState};

/// Returns the state a running run moves to, or `None` while any step is still `queued`.
///
/// With nothing queued, the run is `cancelled` when cancellation was requested, otherwise
/// `failed` when any step failed, otherwise `succeeded` when every step succeeded. Any other
/// combination is reported as `failed`.
pub fn resolve_run(cancel_requested: bool, steps: &[StepState]) -> Option<RunState> {
    if steps.iter().any(|s| *s == StepState::Queued) {
        return None;
    }
    if cancel_requested {
        Some(RunState::Cancelled)
    } else if steps.iter().any(|s| *s == StepState::Failed) {
        Some(RunState::Failed)
    } else if steps.iter().all(|s| *s == StepState::Succeeded) {
        Some(RunState::Succeeded)
    } else {
        Some(RunState::Failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use StepState::*;

    #[test]
    fn queued_steps_keep_the_run_open() {
        for cancel in [false, true] {
            assert_eq!(resolve_run(cancel, &[Succeeded, Queued]), None);
            assert_eq!(resolve_run(cancel, &[Failed, Queued, Skipped]), None);
            assert_eq!(resolve_run(cancel, &[Queued]), None);
        }
    }

    #[test]
    fn cancellation_wins_once_nothing_is_queued() {
        assert_eq!(
            resolve_run(true, &[Succeeded, Cancelled]),
            Some(RunState::Cancelled)
        );
        assert_eq!(
            resolve_run(true, &[Succeeded, Succeeded]),
            Some(RunState::Cancelled)
        );
        assert_eq!(
            resolve_run(true, &[Failed, Skipped]),
            Some(RunState::Cancelled)
        );
    }

    #[test]
    fn a_failed_step_fails_the_run() {
        assert_eq!(
            resolve_run(false, &[Succeeded, Failed, Skipped, Cancelled]),
            Some(RunState::Failed)
        );
        assert_eq!(resolve_run(false, &[Failed]), Some(RunState::Failed));
    }

    #[test]
    fn all_succeeded_succeeds() {
        assert_eq!(
            resolve_run(false, &[Succeeded, Succeeded, Succeeded]),
            Some(RunState::Succeeded)
        );
    }

    #[test]
    fn every_combination_of_two_steps_resolves_consistently() {
        for cancel in [false, true] {
            for a in StepState::ALL {
                for b in StepState::ALL {
                    let got = resolve_run(cancel, &[a, b]);
                    let queued = a == Queued || b == Queued;
                    if queued {
                        assert_eq!(got, None);
                    } else if cancel {
                        assert_eq!(got, Some(RunState::Cancelled));
                    } else if a == Succeeded && b == Succeeded {
                        assert_eq!(got, Some(RunState::Succeeded));
                    } else {
                        assert_eq!(got, Some(RunState::Failed), "{a:?} {b:?}");
                    }
                }
            }
        }
    }
}
