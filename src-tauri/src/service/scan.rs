//! Folder scans (S3-T02, FR-004, FR-021): walk a user-chosen folder off the UI thread and add
//! every regular file to the session's [`FileRegistry`] in batches, reporting progress as it goes.

use crate::adapter::exiftool::process::CancelToken;
use crate::service::files::{FileRegistry, ImportedFile, RejectedPath};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// What a scan includes. The UI shows every field, so the policy in force is always visible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct ScanOptions {
    /// Descend into subfolders.
    pub recursive: bool,
    /// Include files and folders whose name starts with `.`.
    pub include_hidden: bool,
    /// Follow symbolic links whose target lies outside the chosen folder. Off by default: a link
    /// can point anywhere, and the user chose this folder, not the link's target (SPEC §9.2).
    pub follow_outside_links: bool,
    /// Only files with one of these extensions (case-insensitive, no dot); empty means all.
    pub include_extensions: Vec<String>,
    /// Never files with one of these extensions; applied after `include_extensions`.
    pub exclude_extensions: Vec<String>,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            recursive: true,
            include_hidden: false,
            follow_outside_links: false,
            include_extensions: Vec::new(),
            exclude_extensions: Vec::new(),
        }
    }
}

/// Most extensions accepted per list; plenty for a typed filter, and it bounds the input.
const MAX_EXTENSIONS: usize = 100;

impl ScanOptions {
    /// Normalizes renderer input: trims, drops a leading dot, lowercases, removes empties and
    /// duplicates, and caps each list at [`MAX_EXTENSIONS`]. Extensions are only ever compared,
    /// never joined into a path.
    pub fn normalized(mut self) -> Self {
        let clean = |list: Vec<String>| {
            let mut seen = HashSet::new();
            list.into_iter()
                .map(|ext| ext.trim().trim_start_matches('.').to_lowercase())
                .filter(|ext| !ext.is_empty() && seen.insert(ext.clone()))
                .take(MAX_EXTENSIONS)
                .collect()
        };
        self.include_extensions = clean(self.include_extensions);
        self.exclude_extensions = clean(self.exclude_extensions);
        self
    }

    fn wants_extension(&self, path: &Path) -> bool {
        let ext = path
            .extension()
            .map(|ext| ext.to_string_lossy().to_lowercase());
        let listed = |list: &[String]| ext.as_ref().is_some_and(|ext| list.contains(ext));
        (self.include_extensions.is_empty() || listed(&self.include_extensions))
            && !listed(&self.exclude_extensions)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub enum ScanState {
    Running,
    Complete,
    /// Stopped by the user; the counts say exactly what was added before stopping.
    Cancelled,
    /// The folder itself could not be read; nothing was added.
    Failed,
}

/// Running totals for one scan. Every entry looked at ends up in at most one count: files in
/// `added` or `duplicates`; entries the options leave out (a hidden folder counts once) in
/// `filtered`; everything refused (unreadable, special file, link policy, loop) in `skipped`,
/// each also listed once in some update's `problems`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct ScanCounts {
    pub added: u32,
    pub duplicates: u32,
    /// Left out by the hidden-files or extension options.
    pub filtered: u32,
    pub skipped: u32,
}

/// One progress report. `added` and `problems` hold only what is new since the previous update;
/// `counts` is cumulative. The last update of a scan has a state other than `Running`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct ScanUpdate {
    pub scan_id: u32,
    /// The chosen folder, for display.
    pub root: String,
    pub state: ScanState,
    pub added: Vec<ImportedFile>,
    pub problems: Vec<RejectedPath>,
    pub counts: ScanCounts,
}

/// Files handed to the registry at once, so the lock is never held for long.
const BATCH_SIZE: usize = 500;
/// Time between progress updates. Updates go by time, never by count: a fast disk finds
/// thousands of files per 100 ms, and an update per batch flooded the UI faster than it could
/// draw, so a click on Stop waited behind the queue (seen scanning a 200,000-file home folder).
pub const UPDATE_INTERVAL: Duration = Duration::from_millis(200);

/// Walks `root` and registers what it finds, calling `emit` with each [`ScanUpdate`] at most
/// every `interval` (the app passes [`UPDATE_INTERVAL`]; tests pass zero to see every step).
///
/// Flow: canonicalize the root (failure → one `Failed` update) → breadth-first walk with an
/// explicit queue (no recursion, so deep trees cannot overflow the stack), each folder's entries
/// sorted by name for a stable order → per entry: hidden filter → symlink policy → regular file:
/// extension filter, then batch for the registry; folder: queue it if `recursive` → register a
/// batch every [`BATCH_SIZE`] files → emit what is new every [`UPDATE_INTERVAL`] → final update
/// with the end state.
///
/// Gotchas:
/// - Loops: every folder is entered by its canonical path at most once, so a link back to an
///   ancestor (or any cycle of links) is reported as a loop and never walked again.
/// - Links whose target is outside the canonical root are skipped and reported unless
///   `follow_outside_links`; links inside the root are followed (duplicates are then caught by
///   the registry's canonical-path check).
/// - `cancel` is checked before every entry; on cancel, files already registered stay added
///   and the final update says `Cancelled` with honest counts.
/// - The registry lock is held only while a batch is added, so reads and imports keep working.
///
/// Example: a folder with `a.jpg`, `.hidden.jpg` and `sub/b.pdf`, default options → added 2,
/// filtered 1, `Complete`.
pub fn scan(
    scan_id: u32,
    root: &Path,
    options: &ScanOptions,
    cancel: &CancelToken,
    registry: &Mutex<FileRegistry>,
    interval: Duration,
    mut emit: impl FnMut(ScanUpdate),
) {
    let mut update = ScanUpdate {
        scan_id,
        root: root.display().to_string(),
        state: ScanState::Running,
        added: Vec::new(),
        problems: Vec::new(),
        counts: ScanCounts::default(),
    };
    let canonical_root = match fs::canonicalize(root).and_then(|canonical| {
        fs::metadata(&canonical)?
            .is_dir()
            .then_some(canonical)
            .ok_or_else(|| std::io::Error::other("not a folder"))
    }) {
        Ok(canonical) => canonical,
        Err(error) => {
            update.state = ScanState::Failed;
            update
                .problems
                .push(problem(root, &format!("cannot scan: {error}")));
            update.counts.skipped = 1;
            return emit(update);
        }
    };

    let mut walker = Walker {
        update,
        batch: Vec::new(),
        last_emit: Instant::now(),
        registry,
    };
    let mut visited = HashSet::from([canonical_root.clone()]);
    let mut queue = VecDeque::from([root.to_path_buf()]);

    'walk: while let Some(dir) = queue.pop_front() {
        let mut entries = match fs::read_dir(&dir) {
            Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
            Err(error) => {
                walker.skip(&dir, &format!("folder not readable: {error}"));
                continue;
            }
        };
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if cancel.is_cancelled() {
                break 'walk;
            }
            let path = entry.path();
            if !options.include_hidden && entry.file_name().to_string_lossy().starts_with('.') {
                walker.update.counts.filtered += 1;
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                walker.skip(&path, "not readable");
                continue;
            };
            // `canonical` is where the entry really lives; for a non-link it is inside the root.
            let Ok(canonical) = fs::canonicalize(&path) else {
                walker.skip(
                    &path,
                    if kind.is_symlink() {
                        "broken link"
                    } else {
                        "not readable"
                    },
                );
                continue;
            };
            if kind.is_symlink()
                && !options.follow_outside_links
                && !canonical.starts_with(&canonical_root)
            {
                walker.skip(&path, "link points outside the folder (not followed)");
                continue;
            }
            let Ok(meta) = fs::metadata(&canonical) else {
                walker.skip(&path, "not readable");
                continue;
            };
            if meta.is_dir() {
                if !options.recursive {
                    continue;
                }
                if !visited.insert(canonical) {
                    walker.skip(
                        &path,
                        "folder already scanned through another path (link or loop)",
                    );
                    continue;
                }
                queue.push_back(path);
            } else if !meta.is_file() {
                walker.skip(&path, "not a regular file");
            } else if !options.wants_extension(&path) {
                walker.update.counts.filtered += 1;
            } else {
                walker.batch.push(path);
                if walker.batch.len() >= BATCH_SIZE {
                    walker.register();
                }
            }
            if walker.last_emit.elapsed() >= interval {
                walker.flush(&mut emit);
            }
        }
    }

    walker.register();
    walker.update.state = if cancel.is_cancelled() {
        ScanState::Cancelled
    } else {
        ScanState::Complete
    };
    emit(walker.update);
}

fn problem(path: &Path, reason: &str) -> RejectedPath {
    RejectedPath {
        path: path.display().to_string(),
        reason: reason.into(),
    }
}

/// The scan's pending batch and the update being built between two emits.
struct Walker<'a> {
    update: ScanUpdate,
    batch: Vec<PathBuf>,
    last_emit: Instant,
    registry: &'a Mutex<FileRegistry>,
}

impl Walker<'_> {
    fn skip(&mut self, path: &Path, reason: &str) {
        self.update.counts.skipped += 1;
        self.update.problems.push(problem(path, reason));
    }

    /// Adds the pending batch to the registry and folds the result into the update.
    fn register(&mut self) {
        if self.batch.is_empty() {
            return;
        }
        // A poisoned lock only means another thread panicked mid-add; the registry's sets stay
        // consistent (each add is one insert pair), so keep scanning rather than lose the batch.
        let result = self
            .registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .add(self.batch.drain(..));
        let counts = &mut self.update.counts;
        counts.added += result.added.len() as u32;
        counts.duplicates += result.duplicates.len() as u32;
        counts.skipped += result.rejected.len() as u32;
        self.update.added.extend(result.added);
        // Files can vanish or change between listing and registering.
        self.update.problems.extend(result.rejected);
    }

    /// Registers the batch and emits a `Running` update with what is new since the last one.
    fn flush(&mut self, emit: &mut impl FnMut(ScanUpdate)) {
        self.register();
        self.last_emit = Instant::now();
        if self.update.added.is_empty() && self.update.problems.is_empty() {
            return;
        }
        emit(ScanUpdate {
            added: std::mem::take(&mut self.update.added),
            problems: std::mem::take(&mut self.update.problems),
            ..self.update.clone()
        });
    }
}
