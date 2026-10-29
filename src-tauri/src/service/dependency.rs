//! What the UI shows about ExifTool (FR-001, FR-002): which executable is in use, from where, and
//! why not when it is missing, invalid or too old.

use crate::adapter::exiftool::resolver::{resolve, ExifTool, MINIMUM_VERSION};
use crate::domain::error::AppError;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifToolStatus {
    /// `true` when the user chose the executable; an override is never replaced by auto-detection.
    pub is_override: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub minimum_version: String,
    pub error: Option<AppError>,
}

/// Resolves ExifTool and reports the outcome as data instead of an error (FR-001).
///
/// Returns the status for the UI *and* the usable `ExifTool` when there is one, so a command
/// resolves exactly once and acts on the same answer it shows: `read_selected_file` reads with
/// the returned tool, the Settings card shows the status.
///
/// When resolution fails, `path` still shows the override the user chose, so the card can say
/// which file is broken; with auto-detection it is `None`. `minimum_version` comes from the
/// resolver so the install hint never drifts from the real check.
pub fn check(user_override: Option<&Path>) -> (ExifToolStatus, Option<ExifTool>) {
    let minimum_version = format!("{}.{:02}", MINIMUM_VERSION.0, MINIMUM_VERSION.1);
    let is_override = user_override.is_some();
    match resolve(user_override) {
        Ok(tool) => (
            ExifToolStatus {
                is_override,
                path: Some(tool.path.display().to_string()),
                version: Some(tool.version.clone()),
                minimum_version,
                error: None,
            },
            Some(tool),
        ),
        Err(error) => (
            ExifToolStatus {
                is_override,
                path: user_override.map(|path| path.display().to_string()),
                version: None,
                minimum_version,
                error: Some(error.into()),
            },
            None,
        ),
    }
}
