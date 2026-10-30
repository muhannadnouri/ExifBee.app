//! Narrow Tauri commands (SEC-008): the renderer never passes a filesystem path; Rust opens
//! the native dialog and works only with what the user picked.

use crate::adapter::exiftool::process::CancelToken;
use crate::adapter::exiftool::read::{read_metadata, FileMetadata};
use crate::adapter::exiftool::resolver::ExifTool;
use crate::domain::error::{AppError, ErrorKind};
use crate::service::dependency::{self, ExifToolStatus};
use crate::service::files::{FileId, FileRegistry, ImportResult, ImportedFile, RejectedPath};
use crate::service::reads::{self, ReadQueue};
use crate::service::scan::{self, ScanOptions};
use crate::service::settings::SettingsStore;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

pub type SettingsState = Mutex<SettingsStore>;
pub type FilesState = Mutex<FileRegistry>;
pub type ScansState = Mutex<Scans>;
pub type ReadsState = Mutex<ReadQueue>;

/// Folder scans of this session: the options every new scan uses (set from the UI, also used for
/// dropped folders) and a stop switch per running scan.
#[derive(Default)]
pub struct Scans {
    options: ScanOptions,
    /// The folder last chosen in the dialog, waiting for the user to confirm it with options.
    picked: Option<PathBuf>,
    running: HashMap<u32, CancelToken>,
    next: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct AppInfo {
    pub version: String,
    pub settings_warning: Option<String>,
    /// The folder scan options in force, so the UI shows exactly what a dropped folder will use.
    pub scan_options: ScanOptions,
}

/// Unexpected failures (poisoned lock, panicked task, failed settings write) as an IPC error.
fn internal(error: impl ToString) -> AppError {
    AppError::new(ErrorKind::Internal, error.to_string())
}

/// Converts a dialog selection to a filesystem path. Fails only for non-path selections (e.g. a
/// URL from a portal-backed dialog), which ExifBee cannot read.
fn picked_path(picked: FilePath) -> Result<PathBuf, AppError> {
    picked.into_path().map_err(|error| {
        AppError::new(
            ErrorKind::InvalidInput,
            format!("unusable selection: {error}"),
        )
    })
}

/// Copies the override out and releases the lock right away, so slow ExifTool probes never
/// run while holding the settings mutex.
fn current_override(app: &AppHandle) -> Result<Option<PathBuf>, AppError> {
    let state = app.state::<SettingsState>();
    let store = state.lock().map_err(internal)?;
    Ok(store.settings.exiftool_override.clone())
}

/// Runs blocking work (native dialogs, ExifTool, file IO) on Tauri's blocking pool.
///
/// Why: commands are `async`, so they run on the async runtime; a blocking dialog or process
/// there would stall other IPC. Sync commands would instead run on the main thread, where a
/// blocking dialog can deadlock the window. A panic inside `work` becomes an `Internal` error.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(internal)?
}

/// App version for About, the one-time settings recovery warning from startup (shown as a
/// banner and logged by the UI) and the scan options. Cheap and non-blocking, so it stays sync.
#[tauri::command]
pub fn app_info(
    app: AppHandle,
    state: State<'_, SettingsState>,
    scans: State<'_, ScansState>,
) -> Result<AppInfo, AppError> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        settings_warning: state.lock().map_err(internal)?.warning.clone(),
        scan_options: scans.lock().map_err(internal)?.options.clone(),
    })
}

/// Re-resolves ExifTool now and reports it; called at startup, after failed reads and by Retry.
/// Never cached: the user may have installed or removed ExifTool since the last check.
#[tauri::command]
pub async fn exiftool_status(app: AppHandle) -> Result<ExifToolStatus, AppError> {
    blocking(move || Ok(dependency::check(current_override(&app)?.as_deref()).0)).await
}

/// Lets the user pick an ExifTool executable in a native dialog and adopts it if it validates.
///
/// Flow: dialog (Rust side) → probe the picked file → valid: save as the override and return its
/// status → invalid: save nothing and return the failing status, so the UI can say why while
/// the previous setting stays in force → cancelled: `None`.
///
/// Design: there is deliberately no command that takes a path string. The renderer must never be
/// able to name an executable for Rust to run (SEC-008); only the user's own dialog choice can.
#[tauri::command]
pub async fn choose_exiftool_override(app: AppHandle) -> Result<Option<ExifToolStatus>, AppError> {
    blocking(move || {
        let Some(picked) = app
            .dialog()
            .file()
            .set_title("Choose the ExifTool executable")
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = picked_path(picked)?;
        let (status, tool) = dependency::check(Some(&path));
        if tool.is_some() {
            let state = app.state::<SettingsState>();
            let mut store = state.lock().map_err(internal)?;
            let mut settings = store.settings.clone();
            settings.exiftool_override = Some(path);
            store
                .save(settings)
                .map_err(|error| internal(format!("could not save settings: {error}")))?;
        }
        Ok(Some(status))
    })
    .await
}

/// Clears the override (saved immediately) and returns the auto-detection status (FR-002).
#[tauri::command]
pub async fn reset_exiftool_override(app: AppHandle) -> Result<ExifToolStatus, AppError> {
    blocking(move || {
        {
            let state = app.state::<SettingsState>();
            let mut store = state.lock().map_err(internal)?;
            let mut settings = store.settings.clone();
            settings.exiftool_override = None;
            store
                .save(settings)
                .map_err(|error| internal(format!("could not save settings: {error}")))?;
        }
        Ok(dependency::check(None).0)
    })
    .await
}

/// Resolves ExifTool with the current override. If it is unavailable the error is the same one
/// the Settings card shows (`DependencyMissing`, `Unsupported`, …), so the UI can point there.
fn current_tool(app: &AppHandle) -> Result<ExifTool, AppError> {
    let (status, tool) = dependency::check(current_override(app)?.as_deref());
    tool.ok_or_else(|| {
        status
            .error
            .unwrap_or_else(|| internal("ExifTool unavailable"))
    })
}

/// Registers user-chosen paths in the session's [`FileRegistry`].
/// Registers user-chosen paths and queues the new files for background reading.
fn register(app: &AppHandle, paths: Vec<PathBuf>) -> Result<ImportResult, AppError> {
    let result = {
        let state = app.state::<FilesState>();
        let mut registry = state.lock().map_err(internal)?;
        registry.add(paths)
    };
    queue_reads(app, &result.added);
    Ok(result)
}

/// Name of the event that carries the background reads' [`reads::ReadUpdate`]s.
pub const READ_PROGRESS: &str = "read-progress";

/// Queues newly added files for the background read worker and starts it if idle.
///
/// Flow: look the paths up in the registry (the IDs were just issued) → [`ReadQueue::enqueue`]
/// → if no worker runs, start one on the blocking pool that resolves ExifTool once and runs
/// [`reads::drain`], emitting [`READ_PROGRESS`]. Locks are taken one at a time (files, then
/// reads), never nested, so this cannot deadlock with the worker.
fn queue_reads(app: &AppHandle, added: &[ImportedFile]) {
    if added.is_empty() {
        return;
    }
    let files: Vec<(FileId, PathBuf)> = {
        let state = app.state::<FilesState>();
        let registry = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        added
            .iter()
            .filter_map(|file| Some((file.id.clone(), registry.path(&file.id)?.to_path_buf())))
            .collect()
    };
    let start = app
        .state::<ReadsState>()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .enqueue(files);
    if !start {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let tool = current_tool(&app).map_err(|error| error.message);
        reads::drain(&app.state::<ReadsState>(), tool, |update| {
            if let Err(error) = app.emit_to("main", READ_PROGRESS, update) {
                eprintln!("could not deliver read progress to the window: {error}");
            }
        });
    });
}

/// Name of the event that carries a drop's [`ImportResult`] to the renderer.
pub const FILES_DROPPED: &str = "files-dropped";

/// Name of the event that carries each folder scan's [`scan::ScanUpdate`]s to the renderer.
pub const SCAN_PROGRESS: &str = "scan-progress";

/// Starts scanning a user-chosen folder in the background and returns its scan ID at once.
///
/// Flow: take the current options and a fresh stop switch under the lock → scan on the blocking
/// pool, emitting [`SCAN_PROGRESS`] for every update → forget the stop switch when done. The
/// folder comes only from the dialog or a drop, never from the renderer (SEC-008).
fn start_scan(app: &AppHandle, root: PathBuf) -> Result<u32, AppError> {
    let (scan_id, options, cancel) = {
        let state = app.state::<ScansState>();
        let mut scans = state.lock().map_err(internal)?;
        scans.next += 1;
        let cancel = CancelToken::default();
        let scan_id = scans.next;
        scans.running.insert(scan_id, cancel.clone());
        (scan_id, scans.options.clone(), cancel)
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        scan::scan(
            scan_id,
            &root,
            &options,
            &cancel,
            &app.state::<FilesState>(),
            scan::UPDATE_INTERVAL,
            |update| {
                let added = update.added.clone();
                if let Err(error) = app.emit_to("main", SCAN_PROGRESS, update) {
                    eprintln!("could not deliver scan progress to the window: {error}");
                }
                // A cancelled scan's last batch is listed but not checked: Cancel stops both, and
                // queuing it would start a new read run right after the user stopped the old one.
                if !cancel.is_cancelled() {
                    queue_reads(&app, &added);
                }
            },
        );
        if let Ok(mut scans) = app.state::<ScansState>().lock() {
            scans.running.remove(&scan_id);
        }
    });
    Ok(scan_id)
}

/// Handles paths dropped on the window (called from `on_window_event` in `lib.rs`, off the main
/// thread): folders start a scan with the current options; files are registered exactly like a
/// dialog selection and reported through [`FILES_DROPPED`].
///
/// Design: the drop is a user gesture seen by Rust, so its paths go straight into the registry and
/// the renderer only ever receives IDs, the same as for `add_files` (SEC-008). Never fails
/// silently: if registering or starting a scan fails, those paths come back rejected with the
/// reason. A drop of only folders emits no `files-dropped`, since its scans report themselves.
pub fn files_dropped(app: &AppHandle, paths: Vec<PathBuf>) {
    let (folders, files): (Vec<_>, Vec<_>) = paths.into_iter().partition(|path| path.is_dir());
    let rejected = |paths: &[PathBuf], error: &AppError| -> Vec<RejectedPath> {
        paths
            .iter()
            .map(|path| RejectedPath {
                path: path.display().to_string(),
                reason: error.message.clone(),
            })
            .collect()
    };
    let mut result = if files.is_empty() {
        ImportResult::default()
    } else {
        register(app, files.clone()).unwrap_or_else(|error| ImportResult {
            rejected: rejected(&files, &error),
            ..ImportResult::default()
        })
    };
    for folder in folders {
        if let Err(error) = start_scan(app, folder.clone()) {
            result.rejected.extend(rejected(&[folder], &error));
        }
    }
    if result == ImportResult::default() {
        return;
    }
    if let Err(error) = app.emit_to("main", FILES_DROPPED, result) {
        eprintln!("could not deliver dropped files to the window: {error}");
    }
}

/// Opens the native folder dialog and remembers the choice in Rust, returning its path for
/// display only; `None` if cancelled (any earlier choice stays). Step one of Add folder: the
/// user then confirms it with options in ExifBee's dialog ([`scan_picked_folder`]).
///
/// Design: the renderer never sends the path back (SEC-008); the scan uses the one kept here.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, AppError> {
    blocking(move || {
        let Some(picked) = app.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let path = picked_path(picked)?;
        let shown = path.display().to_string();
        app.state::<ScansState>().lock().map_err(internal)?.picked = Some(path);
        Ok(Some(shown))
    })
    .await
}

/// Step two of Add folder: scans the folder chosen with [`pick_folder`] using `options`, which
/// also become the session's options (used for dropped folders and shown next time). Returns
/// the scan ID; progress and files arrive as [`SCAN_PROGRESS`] events. Fails with
/// `InvalidInput` if no folder was chosen.
#[tauri::command]
pub fn scan_picked_folder(app: AppHandle, options: ScanOptions) -> Result<u32, AppError> {
    let root = {
        let state = app.state::<ScansState>();
        let mut scans = state.lock().map_err(internal)?;
        scans.options = options.normalized();
        scans
            .picked
            .take()
            .ok_or_else(|| AppError::new(ErrorKind::InvalidInput, "choose a folder first"))?
    };
    start_scan(&app, root)
}

/// Asks a running scan to stop. Its final update (`Cancelled`) follows as an event, with the
/// files found so far kept. Returns `false` if the scan had already finished.
#[tauri::command]
pub fn cancel_scan(scans: State<'_, ScansState>, scan_id: u32) -> Result<bool, AppError> {
    let scans = scans.lock().map_err(internal)?;
    Ok(scans
        .running
        .get(&scan_id)
        .map(CancelToken::cancel)
        .is_some())
}

/// Lets the user pick any number of files of any type and adds them to the session; `None` if
/// cancelled. Nothing is read here: reads happen per file through `read_file` (FR-003).
///
/// Flow: native multi-select dialog (Rust side) → each selection to a path (a non-path selection,
/// e.g. a URL from a portal-backed dialog, is reported as rejected) → [`FileRegistry::add`].
#[tauri::command]
pub async fn add_files(app: AppHandle) -> Result<Option<ImportResult>, AppError> {
    blocking(move || {
        let Some(picked) = app.dialog().file().blocking_pick_files() else {
            return Ok(None);
        };
        let mut paths = Vec::new();
        let mut unusable = Vec::new();
        for selection in picked {
            let shown = selection.to_string();
            match picked_path(selection) {
                Ok(path) => paths.push(path),
                Err(error) => unusable.push(RejectedPath {
                    path: shown,
                    reason: error.message,
                }),
            }
        }
        let mut result = register(&app, paths)?;
        result.rejected.extend(unusable);
        Ok(Some(result))
    })
    .await
}

/// Most IDs `prioritize_reads` accepts: far more rows than fit on any screen, and a bound on
/// renderer input.
const MAX_PRIORITY_IDS: usize = 1_000;

/// Reads the given files next if they are still queued (the rows in view, sent by the file list
/// as it scrolls). Only reorders the queue: unknown IDs are ignored, and no path is involved.
#[tauri::command]
pub fn prioritize_reads(reads: State<'_, ReadsState>, ids: Vec<FileId>) -> Result<(), AppError> {
    if ids.len() > MAX_PRIORITY_IDS {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            format!("at most {MAX_PRIORITY_IDS} files can be prioritized at once"),
        ));
    }
    let ids = ids.into_iter().collect();
    reads.lock().map_err(internal)?.prioritize(&ids);
    Ok(())
}

/// Stops the background reads: queued files stay unread (selecting one still reads it) and the
/// final `Cancelled` update follows as an event. Returns `false` if nothing was being read.
#[tauri::command]
pub fn cancel_reads(reads: State<'_, ReadsState>) -> Result<bool, AppError> {
    Ok(reads.lock().map_err(internal)?.cancel())
}

/// Reads the metadata of a file added in this session.
///
/// Only an ID the registry issued is accepted; anything else is a `ScopeViolation`, so the
/// renderer can never make Rust open a path of its choosing (SPEC §9).
#[tauri::command]
pub async fn read_file(app: AppHandle, id: FileId) -> Result<FileMetadata, AppError> {
    blocking(move || {
        let path = {
            let state = app.state::<FilesState>();
            let registry = state.lock().map_err(internal)?;
            registry.path(&id).map(PathBuf::from).ok_or_else(|| {
                AppError::new(
                    ErrorKind::ScopeViolation,
                    format!("{id} is not a file added in this session"),
                )
            })?
        };
        Ok(read_metadata(&current_tool(&app)?, &path)?)
    })
    .await
}
