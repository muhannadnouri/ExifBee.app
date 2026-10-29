//! Errors that cross IPC as `{ kind, message }` (NFR-004, S1-T05).
//!
//! `kind` is the stable, closed category the UI branches on; `message` is the specific detail
//! (paths, ExifTool output) shown under it. The TypeScript copies of these types are generated
//! into `src/lib/bindings/` by `cargo test` (DEC-018), and the frontend maps every kind to a
//! title and hint in `src/lib/errors.ts`, so adding a kind here fails the TypeScript build until
//! the UI handles it.

use crate::adapter::exiftool::read::ReadError;
use crate::adapter::exiftool::resolver::ResolveError;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub enum ErrorKind {
    /// ExifTool was not found (no override, or the override file is gone). Fix: install it.
    DependencyMissing,
    /// ExifTool (or a file/tag operation) exists but is not supported, e.g. older than the
    /// tested minimum. Fix: upgrade or choose another executable.
    Unsupported,
    /// The request itself is unusable: relative path, a directory instead of a file, a
    /// non-path dialog selection. Fix: choose something else.
    InvalidInput,
    /// A target is outside the folders/files the user authorized (SPEC §9 scope rules).
    /// Reserved for S3 folder scans and S4 writes; nothing raises it yet.
    ScopeViolation,
    /// ExifTool could not be run or misbehaved: launch failure, timeout, oversized or
    /// unparseable output. Fix: check the installation; details are in the message.
    ProcessFailure,
    /// The user or the app stopped the operation. Reserved for S2-T03 job cancellation.
    Cancelled,
    /// A batch finished with some files failed or skipped. Reserved for S5 batch jobs.
    PartialFailure,
    /// A write reported success but reading back does not match. Reserved for S4 writes.
    VerificationMismatch,
    /// A bug or environment fault inside ExifBee (poisoned lock, failed settings write).
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
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

/// Maps resolver failures to UI categories: `NotFound` → `DependencyMissing` (install hint),
/// `Unsupported` → `Unsupported` (too old), a relative override → `InvalidInput`; everything else
/// (launch failure, timeout, bad output) is `ProcessFailure`. The message keeps the details.
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
            ReadError::Cancelled => ErrorKind::Cancelled,
        };
        Self::new(kind, error.to_string())
    }
}
