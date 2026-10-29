//! Reads one file's metadata as structured JSON (S0-T06 spike; S2-T05 builds the full parser).

use super::argv::{Args, ArgsError};
use super::process::{self, CancelToken, RunError};
use super::resolver::ExifTool;
use crate::domain::metadata::{MetadataValue, StructField, TagEntry};
use serde::Serialize;
use serde_json::{Map, Value};
use std::fmt;
use std::path::Path;
use std::time::Duration;

const READ_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_READ_OUTPUT: usize = 32 * 1024 * 1024;

/// `-G1:4` keys every tag by group and copy number (`IFD0:Make`, `XMP-tiff:Copy1:Make`), so
/// same-name tags stay distinct; `-G4` alone drops the group name (SPEC §4.3, DEC-015).
pub const READ_OPTIONS: &[&str] = &["-json", "-a", "-G1:4", "-s", "-struct"];
/// Quote every JSON value, so numbers keep ExifTool's exact text (DEC-019).
pub const READ_API: &str = "StructFormat=JSONQ";
/// Pathological-output guards on top of the byte cap (S2-T05).
pub const MAX_TAGS_PER_FILE: usize = 100_000;
pub const MAX_NESTING: usize = 32;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct FileMetadata {
    pub source_file: String,
    /// ExifTool's per-file `Error`; the read still returns whatever ExifTool recognized.
    pub error: Option<String>,
    pub warnings: Vec<String>,
    /// Every tag in ExifTool's output order, with full identity and typed value.
    pub tags: Vec<TagEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    InvalidInput(String),
    ProcessFailure(String),
    Cancelled,
}

impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(message) | Self::ProcessFailure(message) => f.write_str(message),
            Self::Cancelled => f.write_str("the read was cancelled"),
        }
    }
}

impl std::error::Error for ReadError {}

/// The exact arguments a single-file read runs (also what a "copy command" view should show).
pub fn read_args(path: &Path) -> Result<Args, ArgsError> {
    Args::new()
        .options(READ_OPTIONS)
        .api(READ_API)
        .files([path])
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
    let output = process::run(
        &tool.path,
        args.as_slice(),
        READ_TIMEOUT,
        MAX_READ_OUTPUT,
        // shortcut: reads are not cancellable from the UI yet; S5-T02 passes the job's token.
        &CancelToken::default(),
    )
    .map_err(|error: RunError| match error {
        RunError::Cancelled => ReadError::Cancelled,
        error => ReadError::ProcessFailure(format!("ExifTool {error}")),
    })?;

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
    parse_output(&output.stdout)
}

/// Turns `-json -a -G1:4 -s -struct -api StructFormat=JSONQ` output for one file into a
/// [`FileMetadata`] (S2-T05).
///
/// Flow: parse the JSON array (exactly one object) → take `SourceFile` → each remaining key
/// becomes a [`TagEntry`] (identity from the key, typed value from the JSON) → collect ExifTool's
/// own `Error`/`Warning` tags for the file.
///
/// Gotchas:
/// - Keys are `Group1:Name` or `Group1:CopyN:Name`; anything else is rejected rather than guessed.
/// - With JSONQ every scalar is a string; a bare JSON number, bool or null means the output was
///   not produced with the expected options and is rejected, so values are never silently
///   rounded.
/// - `(Binary data N bytes, use -b option to extract)` is ExifTool's placeholder for bytes it did
///   not print; it becomes [`MetadataValue::Binary`]. Text ExifTool could not encode as UTF-8 is
///   already replaced by `?` upstream without `-b` (recorded in SPEC §4.4).
/// - Limits: more than [`MAX_TAGS_PER_FILE`] tags or nesting deeper than [`MAX_NESTING`] is
///   rejected as pathological; the byte cap is enforced earlier by the executor.
pub fn parse_output(stdout: &[u8]) -> Result<FileMetadata, ReadError> {
    let failure = |message: String| ReadError::ProcessFailure(message);
    let mut files: Vec<Map<String, Value>> = serde_json::from_slice(stdout)
        .map_err(|error| failure(format!("unexpected ExifTool output: {error}")))?;
    if files.len() != 1 {
        return Err(failure(format!(
            "expected metadata for one file, got {}",
            files.len()
        )));
    }
    let mut object = files.remove(0);
    let source_file = match object.shift_remove("SourceFile") {
        Some(Value::String(source)) => source,
        _ => return Err(failure("ExifTool output has no SourceFile".into())),
    };
    if object.len() > MAX_TAGS_PER_FILE {
        return Err(failure(format!(
            "ExifTool reported {} tags for one file, more than the {MAX_TAGS_PER_FILE} limit",
            object.len()
        )));
    }

    let mut tags = Vec::with_capacity(object.len());
    let (mut error, mut warnings) = (None, Vec::new());
    for (key, value) in object {
        let (group1, copy, name) =
            split_key(&key).ok_or_else(|| failure(format!("unexpected tag key {key:?}")))?;
        let value = typed(value, 0).map_err(|problem| failure(format!("{key}: {problem}")))?;
        if group1 == "ExifTool" {
            if let MetadataValue::Text { text } = &value {
                match name {
                    "Error" => _ = error.get_or_insert_with(|| text.clone()),
                    "Warning" => warnings.push(text.clone()),
                    _ => {}
                }
            }
        }
        tags.push(TagEntry {
            group1: group1.into(),
            copy,
            name: name.into(),
            value,
            key,
        });
    }
    Ok(FileMetadata {
        source_file,
        error,
        warnings,
        tags,
    })
}

/// `IFD0:Make` → (`IFD0`, None, `Make`); `XMP-tiff:Copy1:Make` → (`XMP-tiff`, Some(1), `Make`).
fn split_key(key: &str) -> Option<(&str, Option<u32>, &str)> {
    let parts: Vec<&str> = key.split(':').collect();
    let valid = |part: &&str| !part.is_empty();
    match parts.as_slice() {
        [group, name] if valid(group) && valid(name) => Some((group, None, name)),
        [group, copy, name] if valid(group) && valid(name) => {
            Some((group, Some(copy.strip_prefix("Copy")?.parse().ok()?), name))
        }
        _ => None,
    }
}

fn typed(value: Value, depth: usize) -> Result<MetadataValue, String> {
    if depth > MAX_NESTING {
        return Err(format!("nested deeper than {MAX_NESTING} levels"));
    }
    Ok(match value {
        Value::String(text) => match binary_length(&text) {
            Some(byte_length) => MetadataValue::Binary { byte_length },
            None => MetadataValue::Text { text },
        },
        Value::Array(items) => MetadataValue::List {
            items: items
                .into_iter()
                .map(|item| typed(item, depth + 1))
                .collect::<Result<_, _>>()?,
        },
        Value::Object(fields) => MetadataValue::Structure {
            fields: fields
                .into_iter()
                .map(|(name, value)| {
                    Ok(StructField {
                        name,
                        value: typed(value, depth + 1)?,
                    })
                })
                .collect::<Result<_, String>>()?,
        },
        other => {
            return Err(format!(
                "unquoted JSON value {other} (expected StructFormat=JSONQ)"
            ))
        }
    })
}

/// Recognizes `(Binary data 765 bytes, use -b option to extract)`.
fn binary_length(text: &str) -> Option<Option<u64>> {
    let rest = text.strip_prefix("(Binary data ")?;
    let (count, tail) = rest.split_once(' ')?;
    tail.starts_with("bytes").then(|| count.parse().ok())
}
