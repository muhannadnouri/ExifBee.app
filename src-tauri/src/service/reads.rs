//! Background metadata reads (S3-T03, FR-005, NFR-002): every file added to the session is read
//! in batches by one worker, and the UI receives a short summary per file, never the full
//! metadata of the whole corpus. The selected file's full metadata is read on demand.

use crate::adapter::exiftool::process::CancelToken;
use crate::adapter::exiftool::read::{read_batch, FileMetadata, ReadError, READ_BATCH};
use crate::adapter::exiftool::resolver::ExifTool;
use crate::domain::metadata::MetadataValue;
use crate::service::files::FileId;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;

/// What the file list needs to know about one read file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct ReadSummary {
    pub id: FileId,
    /// `File:FileType` as ExifTool detected it from the content, e.g. `MP4`; `None` if unknown.
    pub file_type: Option<String>,
    /// ExifTool's per-file error, or why the file could not be read at all.
    pub error: Option<String>,
    /// `error` only means ExifTool does not know the format (see `FileMetadata::unsupported`).
    pub unsupported: bool,
    pub warnings: Vec<String>,
    pub tag_count: u32,
}

impl ReadSummary {
    fn failed(id: &FileId, error: String) -> Self {
        Self {
            id: id.clone(),
            file_type: None,
            error: Some(error),
            unsupported: false,
            warnings: Vec::new(),
            tag_count: 0,
        }
    }

    fn of(id: &FileId, file: &FileMetadata) -> Self {
        let file_type = file.tags.iter().find_map(|tag| match &tag.value {
            MetadataValue::Text { text } if tag.key == "File:FileType" => Some(text.clone()),
            _ => None,
        });
        Self {
            id: id.clone(),
            file_type,
            error: file.error.clone(),
            unsupported: file.unsupported,
            warnings: file.warnings.clone(),
            tag_count: file.tags.len() as u32,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub enum ReadState {
    Running,
    Complete,
    /// Stopped by the user; files not yet read stay unread (selecting one still reads it).
    Cancelled,
    /// ExifTool could not be used at all; `message` says why.
    Failed,
}

/// Totals since the queue last went idle: `done` of `total` files have a summary; `errors`
/// excludes files that are only `unsupported`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct ReadCounts {
    pub done: u32,
    pub total: u32,
    pub errors: u32,
    pub warnings: u32,
    pub unsupported: u32,
}

/// One progress report: the summaries new since the last update (at most one batch) and the
/// running totals. A run of the queue ends with exactly one update whose state is not `Running`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct ReadUpdate {
    pub state: ReadState,
    pub results: Vec<ReadSummary>,
    pub counts: ReadCounts,
    pub message: Option<String>,
}

/// Files waiting to be read, shared by everything that adds files and the one worker.
#[derive(Debug, Default)]
pub struct ReadQueue {
    pending: VecDeque<(FileId, PathBuf)>,
    counts: ReadCounts,
    cancel: CancelToken,
    running: bool,
}

impl ReadQueue {
    /// Queues files; returns `true` when no worker is running, so the caller must start one
    /// (and run [`drain`]). Files added while a worker runs join its run and its totals.
    pub fn enqueue(&mut self, files: impl IntoIterator<Item = (FileId, PathBuf)>) -> bool {
        let before = self.pending.len();
        self.pending.extend(files);
        // After a Stop, new files belong to the next run, which counts them when it starts.
        if !self.cancel.is_cancelled() {
            self.counts.total += (self.pending.len() - before) as u32;
        }
        let start = !self.running && !self.pending.is_empty();
        self.running |= start;
        start
    }

    /// Moves the queued files among `ids` to the front, keeping their order, so the rows the user
    /// is looking at are read next. IDs that are not queued (already read, unknown) are ignored.
    pub fn prioritize(&mut self, ids: &HashSet<FileId>) {
        let (first, rest): (VecDeque<_>, VecDeque<_>) =
            self.pending.drain(..).partition(|(id, _)| ids.contains(id));
        self.pending = first;
        self.pending.extend(rest);
    }

    /// Stops the run: drops what is queued and kills the batch in progress. Returns `false` if
    /// nothing was running.
    pub fn cancel(&mut self) -> bool {
        if self.running {
            self.pending.clear();
            self.cancel.cancel();
        }
        self.running
    }
}

/// The worker: reads the queue in batches of [`READ_BATCH`] until it is empty or cancelled.
///
/// Flow: take a batch under the lock → read it without the lock (other files can be queued
/// meanwhile) → fold its summaries into the totals and emit them → repeat → emit the final
/// update and reset the totals. `tool` is resolved once per worker by the caller; if that failed,
/// the run ends `Failed` at once and the queued files stay unread.
///
/// Gotchas:
/// - A cancelled batch emits nothing: its files are neither counted nor summarized, so `done`
///   stays honest.
/// - The end is decided and emitted under the lock, so a file queued at the same moment either
///   joins this run or starts the next. Files queued after a Stop are not lost: once the
///   `Cancelled` update is out, they start a fresh run in this same worker.
pub fn drain(
    queue: &Mutex<ReadQueue>,
    tool: Result<ExifTool, String>,
    mut emit: impl FnMut(ReadUpdate),
) {
    let lock = || {
        queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    };
    let tool = match tool {
        Ok(tool) => tool,
        Err(message) => {
            let mut queue = lock();
            emit(update(ReadState::Failed, &queue, Some(message)));
            *queue = ReadQueue::default();
            return;
        }
    };
    loop {
        let (batch, cancel) = {
            let mut queue = lock();
            let cancelled = queue.cancel.is_cancelled();
            if cancelled || queue.pending.is_empty() {
                let state = if cancelled {
                    ReadState::Cancelled
                } else {
                    ReadState::Complete
                };
                emit(update(state, &queue, None));
                let after_stop = std::mem::take(&mut queue.pending);
                *queue = ReadQueue::default();
                if after_stop.is_empty() || !queue.enqueue(after_stop) {
                    return;
                }
                continue;
            }
            let size = queue.pending.len().min(READ_BATCH);
            let batch: Vec<_> = queue.pending.drain(..size).collect();
            (batch, queue.cancel.clone())
        };
        let Ok(results) = summarize(&tool, &batch, &cancel) else {
            continue; // cancelled: the next turn ends the run
        };
        let mut queue = lock();
        let counts = &mut queue.counts;
        counts.done += results.len() as u32;
        for result in &results {
            counts.unsupported += result.unsupported as u32;
            counts.errors += (result.error.is_some() && !result.unsupported) as u32;
        }
        counts.warnings += results.iter().filter(|r| !r.warnings.is_empty()).count() as u32;
        emit(ReadUpdate {
            state: ReadState::Running,
            results,
            counts: queue.counts,
            message: None,
        });
    }
}

fn update(state: ReadState, queue: &ReadQueue, message: Option<String>) -> ReadUpdate {
    ReadUpdate {
        state,
        results: Vec::new(),
        counts: queue.counts,
        message,
    }
}

/// Reads one batch and returns one summary per file, in batch order; `Err` only if cancelled.
///
/// Isolation: if the whole batch fails (ExifTool crashed, hung past the timeout, exceeded the
/// output cap or printed malformed JSON), it is split in half and each half retried, down to
/// single files, so one bad file only ever fails itself (S3-T03 acceptance). A file ExifTool
/// returned nothing for gets its stderr line as the error.
pub fn summarize(
    tool: &ExifTool,
    batch: &[(FileId, PathBuf)],
    cancel: &CancelToken,
) -> Result<Vec<ReadSummary>, ReadError> {
    let paths: Vec<PathBuf> = batch.iter().map(|(_, path)| path.clone()).collect();
    match read_batch(tool, &paths, cancel) {
        Ok(output) => {
            let by_source: HashMap<&str, &FileMetadata> = output
                .files
                .iter()
                .map(|file| (file.source_file.as_str(), file))
                .collect();
            Ok(batch
                .iter()
                .map(|(id, path)| {
                    let shown = path.to_string_lossy();
                    match by_source.get(shown.as_ref()) {
                        Some(file) => ReadSummary::of(id, file),
                        None => ReadSummary::failed(id, not_read(&output.stderr, &shown)),
                    }
                })
                .collect())
        }
        Err(ReadError::Cancelled) => Err(ReadError::Cancelled),
        Err(error) if batch.len() == 1 => {
            Ok(vec![ReadSummary::failed(&batch[0].0, error.to_string())])
        }
        Err(_) => {
            let (left, right) = batch.split_at(batch.len() / 2);
            let mut results = summarize(tool, left, cancel)?;
            results.extend(summarize(tool, right, cancel)?);
            Ok(results)
        }
    }
}

/// Why ExifTool returned no object for `path`: its stderr line naming the file, if any.
fn not_read(stderr: &str, path: &str) -> String {
    stderr
        .lines()
        .find(|line| line.contains(path))
        .map(|line| line.trim().to_string())
        .unwrap_or_else(|| "ExifTool returned no metadata for this file".into())
}
