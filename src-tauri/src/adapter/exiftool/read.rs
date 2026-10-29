//! Reads one file's metadata as structured JSON (S0-T06 spike; S2-T05 builds the full parser).

use super::argv::{Args, ArgsError};
use super::process::{self, RunError};
use super::resolver::ExifTool;
use serde::Serialize;
use serde_json::{Map, Value};
use std::fmt;
use std::path::Path;
use std::time::Duration;

const READ_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_READ_OUTPUT: usize = 32 * 1024 * 1024;

/// `-G1:4` keys every tag by group and copy number (`IFD0:Make`, `XMP-tiff:Copy1:Make`), so
/// same-name tags stay distinct; `-G4` alone drops the group name (SPEC §4.3, DEC-015).
pub const READ_OPTIONS: &[&str] = &["-json", "-a", "-G1:4", "-s"];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct FileMetadata {
    pub source_file: String,
    /// ExifTool's per-file `Error`; the read still returns whatever ExifTool recognized.
    pub error: Option<String>,
    pub warnings: Vec<String>,
    /// Group-qualified tags in ExifTool's output order.
    pub tags: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    InvalidInput(String),
    ProcessFailure(String),
}

impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(message) | Self::ProcessFailure(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for ReadError {}

/// The exact arguments a single-file read runs (also what a "copy command" view should show).
pub fn read_args(path: &Path) -> Result<Args, ArgsError> {
    Args::new().options(READ_OPTIONS).files([path])
}

/// Reads one file's metadata with `-json -a -G1:4 -s -- <path>` (DEC-015).
///
/// Flow: validate the path → run ExifTool through the shared runner → decide by the *output*:
/// no JSON means a process failure (stderr explains it); JSON means success, even with exit 1,
/// because ExifTool reports per-file problems inside the JSON as `ExifTool:Error`/`Warning`.
///
/// Example result for a JPEG: `source_file = "/photos/a.jpg"`, `tags["IFD0:Make"] = "Canon"`,
/// `tags["XMP-tiff:Copy1:Make"] = "Canon"`: the same tag name in two groups stays two entries.
///
/// Gotchas:
/// - The path must be absolute, so a name like `-foo.jpg` can never be taken for an option;
///   `--` ends option parsing as a second guard.
/// - Directories are rejected: ExifTool would silently read every file inside.
/// - Tag order is ExifTool's (`preserve_order`); `SourceFile` is removed with `shift_remove`
///   because a plain `remove` would move the last tag to the front.
/// - JSON numbers lose their text form (`13.50` → `13.5`); S2-T05 owns raw-value fidelity.
pub fn read_metadata(tool: &ExifTool, path: &Path) -> Result<FileMetadata, ReadError> {
    if !path.is_absolute() {
        return Err(ReadError::InvalidInput(format!(
            "path must be absolute: {}",
            path.display()
        )));
    }
    if !path.is_file() {
        return Err(ReadError::InvalidInput(format!(
            "not a readable file: {}",
            path.display()
        )));
    }

    let args = read_args(path).map_err(|error| ReadError::InvalidInput(error.to_string()))?;
    let output = process::run(&tool.path, args.as_slice(), READ_TIMEOUT, MAX_READ_OUTPUT)
        .map_err(|error: RunError| ReadError::ProcessFailure(format!("ExifTool {error}")))?;

    // ExifTool exits 1 when a file has an Error tag but still prints its JSON, so the output,
    // not the exit status, decides; with no JSON at all, stderr explains the failure.
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.stdout.iter().all(u8::is_ascii_whitespace) {
        return Err(ReadError::ProcessFailure(if stderr.is_empty() {
            format!("ExifTool exited with {} and printed nothing", output.status)
        } else {
            stderr
        }));
    }
    let mut files: Vec<Map<String, Value>> =
        serde_json::from_slice(&output.stdout).map_err(|error| {
            ReadError::ProcessFailure(format!("unexpected ExifTool output: {error}"))
        })?;
    if files.len() != 1 {
        return Err(ReadError::ProcessFailure(format!(
            "expected metadata for one file, got {}",
            files.len()
        )));
    }
    let mut tags = files.remove(0);
    let source_file = match tags.shift_remove("SourceFile") {
        Some(Value::String(source)) => source,
        _ => {
            return Err(ReadError::ProcessFailure(
                "ExifTool output has no SourceFile".into(),
            ))
        }
    };

    let text = |value: &Value| {
        value
            .as_str()
            .map_or_else(|| value.to_string(), String::from)
    };
    let mut error = None;
    let mut warnings = Vec::new();
    for (key, value) in &tags {
        if key.starts_with("ExifTool:") && key.ends_with(":Error") {
            error.get_or_insert_with(|| text(value));
        } else if key.starts_with("ExifTool:") && key.ends_with(":Warning") {
            warnings.push(text(value));
        }
    }
    Ok(FileMetadata {
        source_file,
        error,
        warnings,
        tags,
    })
}
