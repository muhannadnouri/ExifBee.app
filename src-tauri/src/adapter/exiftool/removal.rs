//! What removing a group would take away, found by doing it to a copy (S4-T02, FR-009).
//!
//! Why a dry run: ExifTool's groups nest and differ by format (removing `IFD0` also removes
//! `ExifIFD`; removing `PNG` keeps the image-structure tags), so no list of the file's tags can
//! say exactly what goes. ExifTool writes the result to a new file in ExifBee's private folder
//! (`-o`); the user's file is only read.

use super::argv::Args;
use super::process::{self, CancelToken, RunError};
use super::read::{read_metadata, FileMetadata, ReadError};
use super::resolver::ExifTool;
use crate::domain::edit::DeleteGroup;
use crate::domain::metadata::TagEntry;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// A preview writes a whole copy of the file, so large videos need time.
const PREVIEW_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_PREVIEW_OUTPUT: usize = 1024 * 1024;
/// Groups whose tags change on any write or are not stored in the file: never "removed".
const NOT_STORED: &[&str] = &["System", "ExifTool", "Composite"];

/// The result of trying a removal on a copy.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct RemovalPreview {
    /// Tags of the file that the removal takes away, in the file's order.
    pub removed: Vec<TagEntry>,
    /// ExifTool's warnings and errors, e.g. `Not a deletable group: System`.
    pub messages: Vec<String>,
}

/// Removes the private folder on every exit path, including errors and cancellation.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Runs `delete` against a copy of `path` written into a new private folder under `work_dir`,
/// then compares the two reads.
///
/// Flow: create `work_dir/removal-<pid>-<n>` (0700, fails if it exists) → `exiftool -G:All= -o
/// <folder>/preview<.ext> -- <path>` → read both files → removed = tags of the original that the
/// copy no longer has → delete the folder.
///
/// Gotchas:
/// - Tags are matched by group and name, not by key: removing `IFD0:Make` renames the surviving
///   `XMP-tiff:Copy1:Make` to `XMP-tiff:Make`, which is not a removal.
/// - When there is nothing to remove ExifTool still copies the file (exit 0) and explains on
///   stderr; when it cannot write the format it creates no copy (exit 1). Both come back as an
///   empty `removed` with ExifTool's messages.
pub fn preview_group_removal(
    tool: &ExifTool,
    path: &Path,
    delete: &DeleteGroup,
    work_dir: &Path,
    cancel: &CancelToken,
) -> Result<RemovalPreview, ReadError> {
    let before = read_metadata(tool, path)?;
    let edits = Args::new()
        .delete_group(delete)
        .map_err(|error| ReadError::InvalidInput(error.to_string()))?;
    let DryRun { after, messages } = dry_run(tool, path, edits, work_dir, cancel)?;
    let Some(after) = after else {
        return Ok(RemovalPreview {
            removed: Vec::new(),
            messages,
        });
    };
    let mut left: HashMap<(String, String), usize> = HashMap::new();
    for tag in after.tags {
        *left.entry((tag.group1, tag.name)).or_default() += 1;
    }
    let removed = before
        .tags
        .into_iter()
        .filter(|tag| !NOT_STORED.contains(&tag.group1.as_str()))
        .filter(
            |tag| match left.get_mut(&(tag.group1.clone(), tag.name.clone())) {
                Some(count) if *count > 0 => {
                    *count -= 1;
                    false
                }
                _ => true,
            },
        )
        .collect();
    Ok(RemovalPreview { removed, messages })
}

/// What ExifTool did to a private copy: the copy as read back (`None` when ExifTool made no
/// copy, e.g. a format it cannot write) and its warnings and errors.
pub struct DryRun {
    pub after: Option<FileMetadata>,
    pub messages: Vec<String>,
}

/// Runs `edits` against `path` with the result written to a new file in a private folder under
/// `work_dir` (`-o`), reads that copy, and deletes the folder. `path` is only read. Used for
/// group removals (S4-T02) and copies (S4-T06), whose effect only ExifTool can tell.
pub fn dry_run(
    tool: &ExifTool,
    path: &Path,
    edits: Args,
    work_dir: &Path,
    cancel: &CancelToken,
) -> Result<DryRun, ReadError> {
    let scratch = Scratch(private_folder(work_dir)?);
    let mut name = std::ffi::OsString::from("preview");
    if let Some(extension) = path.extension() {
        name.push(".");
        name.push(extension);
    }
    let copy = scratch.0.join(name);
    let args = edits
        .output(&copy)
        .and_then(|args| args.files([path]))
        .map_err(|error| ReadError::InvalidInput(error.to_string()))?;
    let output = process::run(
        &tool.path,
        args.as_slice(),
        PREVIEW_TIMEOUT,
        MAX_PREVIEW_OUTPUT,
        cancel,
    )
    .map_err(|error| match error {
        RunError::Cancelled => ReadError::Cancelled,
        error => ReadError::ProcessFailure(format!("ExifTool {error}")),
    })?;
    let messages = String::from_utf8_lossy(&output.stderr)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    let after = if copy.is_file() {
        Some(read_metadata(tool, &copy)?)
    } else {
        None
    };
    Ok(DryRun { after, messages })
}

/// A new folder only this user can open, named so concurrent previews never share one.
fn private_folder(work_dir: &Path) -> Result<PathBuf, ReadError> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let failure = |error: std::io::Error| {
        ReadError::ProcessFailure(format!("cannot create a preview folder: {error}"))
    };
    fs::create_dir_all(work_dir).map_err(failure)?;
    let folder = work_dir.join(format!(
        "removal-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&folder).map_err(failure)?;
    Ok(folder)
}
