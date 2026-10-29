//! Narrow Tauri commands (SEC-008): the renderer never passes a filesystem path; Rust opens
//! the native dialog and works only with what the user picked.

use crate::adapter::exiftool::read::{read_metadata, FileMetadata};
use crate::domain::error::{AppError, ErrorKind};
use crate::service::dependency::{self, ExifToolStatus};
use crate::service::settings::SettingsStore;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

pub type SettingsState = Mutex<SettingsStore>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct AppInfo {
    pub version: String,
    pub settings_warning: Option<String>,
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

/// App version for About, plus the one-time settings recovery warning from startup (shown as a
/// banner and logged by the UI). Cheap and non-blocking, so it stays a sync command.
#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, SettingsState>) -> Result<AppInfo, AppError> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        settings_warning: state.lock().map_err(internal)?.warning.clone(),
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

/// Lets the user pick one file of any type and returns its metadata; `None` if cancelled.
///
/// Flow: native dialog → resolve ExifTool with the current override → read. If ExifTool is
/// unavailable the error is the same one the Settings card shows (`DependencyMissing`,
/// `Unsupported`, …), so the UI can point to Settings.
// shortcut: one file per dialog; multi-select, drag-and-drop and batched reads come with S3-T01.
#[tauri::command]
pub async fn read_selected_file(app: AppHandle) -> Result<Option<FileMetadata>, AppError> {
    blocking(move || {
        let Some(picked) = app.dialog().file().blocking_pick_file() else {
            return Ok(None);
        };
        let path = picked_path(picked)?;
        let (status, tool) = dependency::check(current_override(&app)?.as_deref());
        let tool = tool.ok_or_else(|| {
            status
                .error
                .unwrap_or_else(|| internal("ExifTool unavailable"))
        })?;
        Ok(Some(read_metadata(&tool, &path)?))
    })
    .await
}
