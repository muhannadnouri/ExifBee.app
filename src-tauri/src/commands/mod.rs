//! Narrow Tauri commands (SEC-008): the renderer never passes a filesystem path; Rust opens
//! the native dialog and reads only the file the user picked.

use crate::adapter::exiftool::read::{read_metadata, FileMetadata};
use crate::adapter::exiftool::resolver::resolve;
use crate::domain::error::{AppError, ErrorKind};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Lets the user pick one file of any type and returns its metadata; `None` if cancelled.
#[tauri::command]
pub async fn read_selected_file(app: AppHandle) -> Result<Option<FileMetadata>, AppError> {
    // The dialog and ExifTool both block, so keep them off the async runtime's workers.
    tauri::async_runtime::spawn_blocking(move || {
        let Some(picked) = app.dialog().file().blocking_pick_file() else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|error| {
            AppError::new(
                ErrorKind::InvalidInput,
                format!("unusable selection: {error}"),
            )
        })?;
        let tool = resolve(None)?;
        Ok(Some(read_metadata(&tool, &path)?))
    })
    .await
    .map_err(|error| AppError::new(ErrorKind::Internal, error.to_string()))?
}
