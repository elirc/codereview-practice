//! Roles, actions and the queue scope of an API caller.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::state::UnknownVariant;

/// Queue list entry that grants a submitter every queue.
pub const ALL_QUEUES: &str = "*";

/// Role of an API token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Viewer,
    Submitter,
    Operator,
    Admin,
}

impl Role {
    pub const ALL: [Role; 4] = [Role::Viewer, Role::Submitter, Role::Operator, Role::Admin];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Submitter => "submitter",
            Self::Operator => "operator",
            Self::Admin => "admin",
        }
    }
}

impl FromStr for Role {
    type Err = UnknownVariant;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|r| r.as_str() == s)
            .ok_or_else(|| UnknownVariant {
                kind: "role",
                value: s.to_string(),
            })
    }
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Something a caller may ask the API to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Read queues, jobs and workflow runs.
    Read,
    /// Read schedules and workflow definitions.
    ReadConfiguration,
    Enqueue,
    StartRun,
    /// Cancel a job or a workflow run.
    Cancel,
    /// Requeue dead jobs and retry failed runs.
    Recover,
    /// Pause and resume queues and schedules.
    Control,
    /// Create and edit queues, schedules and workflow definitions.
    Configure,
    ManageTokens,
}

/// The authenticated caller of an API request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub token_id: Uuid,
    pub role: Role,
    pub queues: Vec<String>,
}

impl Caller {
    /// Returns true when the caller's role permits `action`.
    pub fn may(&self, action: Action) -> bool {
        match self.role {
            Role::Admin => true,
            Role::Operator => !matches!(action, Action::Configure | Action::ManageTokens),
            Role::Submitter => matches!(
                action,
                Action::Read | Action::Enqueue | Action::StartRun | Action::Cancel
            ),
            Role::Viewer => matches!(action, Action::Read | Action::ReadConfiguration),
        }
    }

    /// Returns true when the caller may see and use `queue`.
    pub fn may_use_queue(&self, queue: &str) -> bool {
        match self.queue_scope() {
            None => true,
            Some(queues) => queues.iter().any(|q| q == queue),
        }
    }

    /// Returns true when the caller may use every queue in `queues`.
    pub fn may_use_all<'a>(&self, mut queues: impl Iterator<Item = &'a str>) -> bool {
        queues.all(|q| self.may_use_queue(q))
    }

    /// Returns the queues the caller is limited to, or `None` when it may use every queue.
    pub fn queue_scope(&self) -> Option<&[String]> {
        if self.role == Role::Submitter && !self.queues.iter().any(|q| q == ALL_QUEUES) {
            Some(&self.queues)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caller(role: Role, queues: &[&str]) -> Caller {
        Caller {
            token_id: Uuid::nil(),
            role,
            queues: queues.iter().map(|q| q.to_string()).collect(),
        }
    }

    #[test]
    fn permission_matrix() {
        use Action::*;
        let all = [
            Read,
            ReadConfiguration,
            Enqueue,
            StartRun,
            Cancel,
            Recover,
            Control,
            Configure,
            ManageTokens,
        ];
        let allowed = |role: Role| -> Vec<Action> {
            let c = caller(role, &["*"]);
            all.iter().copied().filter(|a| c.may(*a)).collect()
        };
        assert_eq!(allowed(Role::Viewer), vec![Read, ReadConfiguration]);
        assert_eq!(allowed(Role::Submitter), vec![Read, Enqueue, StartRun, Cancel]);
        assert_eq!(
            allowed(Role::Operator),
            vec![Read, ReadConfiguration, Enqueue, StartRun, Cancel, Recover, Control]
        );
        assert_eq!(allowed(Role::Admin), all.to_vec());
    }

    #[test]
    fn submitter_scope() {
        let c = caller(Role::Submitter, &["email"]);
        assert!(c.may_use_queue("email"));
        assert!(!c.may_use_queue("billing"));
        assert!(c.may_use_all(["email"].into_iter()));
        assert!(!c.may_use_all(["email", "billing"].into_iter()));
        assert_eq!(c.queue_scope(), Some(&["email".to_string()][..]));
    }

    #[test]
    fn wildcard_and_other_roles_are_unscoped() {
        assert!(caller(Role::Submitter, &["*"]).may_use_queue("anything"));
        assert!(caller(Role::Viewer, &[]).may_use_queue("anything"));
        assert_eq!(caller(Role::Operator, &[]).queue_scope(), None);
    }

    #[test]
    fn roles_parse() {
        for role in Role::ALL {
            assert_eq!(role.as_str().parse::<Role>().unwrap(), role);
        }
        assert!("root".parse::<Role>().is_err());
    }
}
