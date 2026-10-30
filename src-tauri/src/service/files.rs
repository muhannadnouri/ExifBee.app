//! The session's file registry (S3-T01, SPEC §9): which files the user added, under opaque IDs.
//! Commands after import take a [`FileId`], never a path, so the renderer can only ask about
//! files the user chose through a Rust-owned dialog or drop.

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// Opaque session-scoped handle such as `f12`. It carries no path information and is only
/// meaningful to the registry that issued it.
pub type FileId = String;

/// What the UI may know about an added file: a handle plus display data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct ImportedFile {
    pub id: FileId,
    /// File name for lists, e.g. `IMG_0042.jpg`.
    pub name: String,
    /// Full path for display and tooltips only; never accepted back by any command.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct RejectedPath {
    pub path: String,
    pub reason: String,
}

/// The outcome of one import (a dialog selection or a drop), so the UI can report it honestly.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct ImportResult {
    pub added: Vec<ImportedFile>,
    /// Paths skipped because the same file is already in the list (or twice in this import).
    pub duplicates: Vec<String>,
    pub rejected: Vec<RejectedPath>,
}

#[derive(Debug)]
struct Entry {
    id: FileId,
    path: PathBuf,
}

#[derive(Debug, Default)]
pub struct FileRegistry {
    entries: Vec<Entry>,
    /// Canonical paths already registered, so a symlink and its target count as one file.
    known: HashSet<PathBuf>,
    next: u64,
}

impl FileRegistry {
    /// Registers user-chosen paths and reports what happened to each.
    ///
    /// Flow per path: must be absolute → resolve its canonical path (symlinks followed; failure
    /// means missing or unreadable) → must be a regular file (folders are scanned by
    /// `service::scan` instead; FIFOs, sockets and devices are refused because reading one can block forever) →
    /// skip if its canonical path is already registered → otherwise add under a new ID.
    ///
    /// Any extension or format is accepted: what ExifTool can read is ExifTool's decision (FR-003).
    /// The path kept is the one the user chose (it may be a symlink); identity uses the canonical
    /// path. S4 re-checks identity right before any write (SPEC §9).
    pub fn add(&mut self, paths: impl IntoIterator<Item = PathBuf>) -> ImportResult {
        let mut result = ImportResult::default();
        for path in paths {
            let shown = path.display().to_string();
            let reject = |reason: &str| RejectedPath {
                path: shown.clone(),
                reason: reason.into(),
            };
            if !path.is_absolute() {
                result.rejected.push(reject("not an absolute path"));
                continue;
            }
            let Ok(canonical) = fs::canonicalize(&path) else {
                result.rejected.push(reject("missing or not readable"));
                continue;
            };
            let Ok(meta) = fs::metadata(&canonical) else {
                result.rejected.push(reject("missing or not readable"));
                continue;
            };
            if meta.is_dir() {
                result.rejected.push(reject("is a folder"));
                continue;
            }
            if !meta.is_file() {
                result.rejected.push(reject("not a regular file"));
                continue;
            }
            if !self.known.insert(canonical) {
                result.duplicates.push(shown);
                continue;
            }
            self.next += 1;
            let id = format!("f{}", self.next);
            result.added.push(ImportedFile {
                id: id.clone(),
                name: path
                    .file_name()
                    .map_or_else(|| shown.clone(), |name| name.to_string_lossy().into_owned()),
                path: shown,
            });
            self.entries.push(Entry { id, path });
        }
        result
    }

    /// The path behind an ID this registry issued; `None` for anything else.
    pub fn path(&self, id: &str) -> Option<&Path> {
        self.entries
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.path.as_path())
    }
}
