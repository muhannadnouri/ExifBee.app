//! The session's file registry (S3-T01, SPEC §9): which files the user added, under opaque IDs.
//! Commands after import take a [`FileId`], never a path, so the renderer can only ask about
//! files the user chose through a Rust-owned dialog or drop.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
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
    /// What each file was when the user last inspected it (`read_file`), for the plan's
    /// staleness check (S4-T03).
    identities: HashMap<FileId, FileIdentity>,
    next: u64,
}

/// Which file a path is right now: where it really lives and its size and modification time.
///
/// Why device and inode too: a file replaced by another of the same size and time (or a symlink
/// pointed elsewhere) must not pass as the file the user inspected (SPEC §4.5, SEC-006).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileIdentity {
    /// The canonical path: symlinks resolved. Writes go here, never through a link.
    pub real_path: PathBuf,
    pub device: u64,
    pub inode: u64,
    pub size: u64,
    pub modified_ns: i128,
}

impl FileIdentity {
    /// The identity of the file `path` leads to now; an error if it is missing or unreadable.
    pub fn of(path: &Path) -> std::io::Result<Self> {
        let real_path = fs::canonicalize(path)?;
        let meta = fs::metadata(&real_path)?;
        let modified_ns = meta
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos() as i128);
        #[cfg(unix)]
        let (device, inode) = {
            use std::os::unix::fs::MetadataExt;
            (meta.dev(), meta.ino())
        };
        // shortcut: no file index on other platforms yet; size + time + path only until S8.
        #[cfg(not(unix))]
        let (device, inode) = (0, 0);
        Ok(Self {
            real_path,
            device,
            inode,
            size: meta.len(),
            modified_ns,
        })
    }
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

    /// Remembers what file `id` was when it was read for inspection.
    pub fn record(&mut self, id: &str, identity: FileIdentity) {
        self.identities.insert(id.to_string(), identity);
    }

    /// What file `id` was when last read for inspection; `None` if it never was.
    pub fn identity(&self, id: &str) -> Option<&FileIdentity> {
        self.identities.get(id)
    }

    /// The path behind an ID this registry issued; `None` for anything else.
    pub fn path(&self, id: &str) -> Option<&Path> {
        self.entries
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.path.as_path())
    }
}
