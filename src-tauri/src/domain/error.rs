//! Errors that cross IPC as `{ kind, message }` (NFR-004). Kinds use the S1-T05 taxonomy names;
//! S1-T05 adds the remaining kinds and typed frontend bindings.

use crate::adapter::exiftool::read::ReadError;
use crate::adapter::exiftool::resolver::ResolveError;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ErrorKind {
    DependencyMissing,
    Unsupported,
    InvalidInput,
    ProcessFailure,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<ResolveError> for AppError {
    fn from(error: ResolveError) -> Self {
        let kind = match error {
            ResolveError::NotFound { .. } => ErrorKind::DependencyMissing,
            ResolveError::Unsupported { .. } => ErrorKind::Unsupported,
            ResolveError::NotAbsolute { .. } => ErrorKind::InvalidInput,
            _ => ErrorKind::ProcessFailure,
        };
        Self::new(kind, error.to_string())
    }
}

impl From<ReadError> for AppError {
    fn from(error: ReadError) -> Self {
        let kind = match error {
            ReadError::InvalidInput(_) => ErrorKind::InvalidInput,
            ReadError::ProcessFailure(_) => ErrorKind::ProcessFailure,
        };
        Self::new(kind, error.to_string())
    }
}
