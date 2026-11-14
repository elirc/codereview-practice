//! Helpers for validating request bodies after deserialization.

use serde::{Deserialize, Deserializer};

use crate::error::{ApiError, FieldError};

/// Collects field errors and turns them into a single validation error.
#[derive(Debug, Default)]
pub struct Problems(Vec<FieldError>);

impl Problems {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records `message` for `path` unless `ok` holds.
    pub fn check(&mut self, ok: bool, path: &str, message: &str) {
        if !ok {
            self.0.push(FieldError::new(path, message));
        }
    }

    /// Records `message` for `path` when `value` is set and outside `min..=max`.
    pub fn range<T: PartialOrd + Copy>(&mut self, value: Option<T>, min: T, max: T, path: &str) {
        if let Some(v) = value {
            if v < min || v > max {
                self.0.push(FieldError::new(path, "is out of range"));
            }
        }
    }

    /// Returns an error when any problem was recorded.
    pub fn finish(self) -> Result<(), ApiError> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(ApiError::Validation(self.0))
        }
    }
}

/// Deserializes a field that distinguishes "absent" (`None`) from "null" (`Some(None)`).
/// Use together with `#[serde(default)]`.
pub fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
