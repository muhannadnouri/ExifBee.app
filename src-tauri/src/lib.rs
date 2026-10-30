pub mod adapter;
pub mod commands;
pub mod domain;
pub mod platform;
pub mod service;

use service::settings::SettingsStore;
use std::sync::Mutex;
use tauri::{DragDropEvent, Manager, WindowEvent};

/// Builds and runs the app. Startup flow: register the dialog plugin (used from Rust only; no
/// capability grants it to the renderer) → load settings from the OS config dir into managed
/// state (never fails; see `SettingsStore::load`) and start an empty file registry → hand file
/// drops to `commands::files_dropped` → expose the narrow command set (SEC-008).
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage::<commands::SettingsState>(Mutex::new(SettingsStore::load(&dir)));
            app.manage::<commands::FilesState>(Mutex::default());
            app.manage::<commands::ScansState>(Mutex::default());
            app.manage::<commands::ReadsState>(Mutex::default());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                let (app, paths) = (window.app_handle().clone(), paths.clone());
                // Off the event loop: checking thousands of dropped paths must not freeze the window.
                tauri::async_runtime::spawn_blocking(move || commands::files_dropped(&app, paths));
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::exiftool_status,
            commands::choose_exiftool_override,
            commands::reset_exiftool_override,
            commands::add_files,
            commands::read_file,
            commands::pick_folder,
            commands::scan_picked_folder,
            commands::cancel_scan,
            commands::cancel_reads,
            commands::prioritize_reads,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ExifBee");
}

#[cfg(test)]
mod tests {
    // @req OPS-001
    #[test]
    fn tauri_config_compiles_into_desktop_context() {
        let context: tauri::Context = tauri::generate_context!();
        let config = context.config();
        assert_eq!(config.identifier, "app.exifbee");
        let window = &config.app.windows[0];
        assert_eq!(window.title, "ExifBee");
        // 1280×800 at 200% scaling leaves a 640×400 logical screen; the window must fit it.
        assert!(window.min_width.unwrap() <= 640.0 && window.min_height.unwrap() <= 400.0);
    }
}
